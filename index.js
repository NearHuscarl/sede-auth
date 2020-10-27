require("dotenv").config({ path: ".env.local" })

const fs = require("fs").promises
const express = require("express")
const bodyParser = require("body-parser")
const fetch = require("node-fetch")
const jsdom = require("jsdom")

const app = express()
const port = process.env.PORT || 80
const originWhitelist = process.env.ORIGIN_WHITELIST
  ? process.env.ORIGIN_WHITELIST.split(",")
  : []

function writeHelper(req, res) {
  fs.readFile("./README.html", "utf-8").then((data) => {
    res.writeHead(403, { "content-type": "text/html" })
    res.end(data)
  })
}

const nodeModules = (path) => __dirname + "/node_modules/" + path

app.use(bodyParser.urlencoded({ extended: false }))
app.use("/images", express.static(__dirname + "/images"))
app.use(
  "/github-markdown.css",
  express.static(nodeModules("github-markdown-css/github-markdown.css"))
)
app.use(
  "/github.css",
  express.static(nodeModules("highlight.js/styles/github.css"))
)

app.get("/", (req, res) => {
  writeHelper(req, res)
})

app.use((req, res, next) => {
  const { origin } = req.headers
  const inWhitelist =
    originWhitelist.length > 0 && originWhitelist.indexOf(origin) === -1
  if (origin && !inWhitelist) {
    res.writeHead(403, "Forbidden", req.headers)
    res.end(
      'The origin "' +
        origin +
        '" was not whitelisted by the operator of this proxy.'
    )
    return
  }

  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "DELETE, PUT")
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Auth-Cookie"
  )
  if ("OPTIONS" === req.method) {
    res.sendStatus(200)
  } else {
    next()
  }
})

// thank you very much Glorfindel
// https://meta.stackexchange.com/questions/264678
app.post("/auth", (req, res) => {
  const { email, password } = req.body
  const authUrl = "https://data.stackexchange.com/user/authenticate"
  const body = new URLSearchParams(
    "oauth2url=https://stackoverflow.com/oauth&openid="
  )
  let providenceCookie = ""

  console.log("POST", authUrl)
  fetch(authUrl, { method: "POST", body, redirect: "manual" })
    .then((r) => {
      const headers = r.headers.raw()
      const loginUrl = headers["location"][0]
      console.log("GET", loginUrl)
      return fetch(loginUrl, { redirect: "manual" })
    })
    .then((r) => {
      const rawHeaders = r.headers.raw()
      providenceCookie = rawHeaders["set-cookie"].find((c) =>
        c.startsWith("prov=")
      )
      const loginUrl = rawHeaders["location"][0]
      const headers = {
        Cookie: providenceCookie,
      }
      console.log("GET", loginUrl)

      if (!providenceCookie) {
        throw new Error("No providence cookie found.")
      }

      return fetch(loginUrl, { headers })
    })
    .then((r) => r.text())
    .then((text) => {
      const dom = new jsdom.JSDOM(text)
      const { document } = dom.window
      const actionUrl = document
        .getElementById("login-form")
        .getAttribute("action")
      const headers = { Cookie: providenceCookie }
      const body = new URLSearchParams({
        fkey: document.querySelector("input[name='fkey']").value,
        email,
        password,
      })
      const url = "https://stackoverflow.com" + actionUrl
      console.log("POST", url)

      return fetch(url, { method: "POST", body, headers, redirect: "manual" })
    })
    .then((r) => {
      return Promise.all([r.headers.raw(), r.text()])
    })
    .then(async ([rawHeaders, text]) => {
      const dom = new jsdom.JSDOM(text)
      const { document } = dom.window
      const errorEl = document.querySelector(".js-error-message")

      if (errorEl) {
        const error = errorEl.textContent.trim()
        res.send({ error })
        return
      }

      if (!rawHeaders["set-cookie"]) {
        throw new Error("No cookie found.")
      }

      const accountCookie = rawHeaders["set-cookie"].find((c) =>
        c.startsWith("acct=")
      )
      let redirectUrl = rawHeaders["location"][0]

      if (!accountCookie) {
        throw new Error("No account cookie found.")
      }

      // OAuth2 redirection
      // 1. https://stackoverflow.com/oauth?client_id=...
      // 2. http://data.stackexchange.com/user/oauth/stackapps?code=...
      // 3. https://data.stackexchange.com/user/oauth/stackapps?code=...
      for (let i = 1; i <= 3; i++) {
        console.log("GET", redirectUrl)
        const headers = {
          Cookie:
            i === 1
              ? `${providenceCookie}; ${accountCookie}`
              : providenceCookie,
        }
        const r = await fetch(redirectUrl, { headers, redirect: "manual" })
        const rawHeaders = r.headers.raw()

        if (i === 3) {
          const authCookie = rawHeaders["set-cookie"].find((c) =>
            c.startsWith(".ASPXAUTH=")
          )
          res.send({ authCookie })
        } else {
          redirectUrl = rawHeaders["location"][0]
        }
      }
    })
    .catch((e) => {
      console.log(e)
      res.status(500).send()
    })
})

app.post("/query/run/:siteId/:queryId/:revisionId", (req, res) => {
  // siteId: https://data.stackexchange.com/sites
  const { siteId, queryId, revisionId } = req.params
  const url = `https://data.stackexchange.com/query/run/${siteId}/${queryId}/${revisionId}`
  const body = new URLSearchParams(req.body)
  const headers = { Cookie: req.headers["auth-cookie"] }

  // I'm not a back-end developer (yet?), and it's not the cleanest code I've written but at least it works for now
  fetch(url, { method: "POST", body, headers })
    .then((r) => {
      return r.json()
    })
    .then((json) => {
      const { job_id } = json
      if (!job_id) {
        return res.send(json)
      }

      // the operation takes some time and result is not in cache. Polling
      console.log(`start polling job: ${job_id}`)

      const pollInterval = 1000
      const pollTimeout = 10_000
      const before = Date.now()

      async function poll() {
        if (Date.now() - before > pollTimeout) {
          return res
            .status(503)
            .send({ error: `Response timeout after ${pollTimeout}ms` })
        }

        const url = `https://data.stackexchange.com/query/job/${job_id}?=${Date.now()}`
        console.log("GET", url)
        const json = await fetch(url).then((r) => r.json())
        if (json.running) {
          setTimeout(poll, pollInterval)
        } else {
          res.send(json)
        }
      }

      setTimeout(poll, pollInterval)
    })
    .catch((e) => {
      console.log(e)
      res.status(500).send()
    })
})

app.listen(port, () => console.log(`Listening on port ${port}`))
