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
    res.send(data)
  })
}

function handleError(res, e) {
  console.log(e)
  if (Array.isArray(e) && e.length === 2) {
    const [statusCode, error] = e
    res.status(statusCode).send({ error })
  } else {
    res.status(500).send()
  }
}

function getLoginPage(oauthRes) {
  const rawHeaders = oauthRes.headers.raw()
  // response headers from https://stackoverflow.com/oauth?client_id=
  const providenceCookie = rawHeaders["set-cookie"].find((c) =>
    c.startsWith("prov=")
  )
  const loginUrl = rawHeaders["location"][0]
  const headers = {
    Cookie: providenceCookie,
  }

  if (!providenceCookie) {
    throw [500, "No providence cookie found."]
  }

  console.log("GET", loginUrl)
  return Promise.all([
    fetch(loginUrl, { headers }).then((r) => r.text()),
    providenceCookie,
  ])
}

function submitLoginForm({ html, email, password, providenceCookie }) {
  const dom = new jsdom.JSDOM(html)
  const { document } = dom.window
  const actionUrl = document.getElementById("login-form").getAttribute("action")
  const headers = { Cookie: providenceCookie }
  const body = new URLSearchParams({
    fkey: document.querySelector("input[name='fkey']").value,
    email,
    password,
  })
  const url = "https://stackoverflow.com" + actionUrl
  console.log("POST", url)
  return fetch(url, {
    method: "POST",
    body,
    headers,
    redirect: "manual",
  }).then((r) => Promise.all([r.headers.raw(), r.text()]))
}

function validateLoginResult({ html, headers }) {
  const dom = new jsdom.JSDOM(html)
  const { document } = dom.window
  const errorEl = document.querySelector(".js-error-message")

  if (errorEl) {
    const error = errorEl.textContent.trim()
    throw [400, error]
  }

  if (!headers["set-cookie"]) {
    throw [500, "No cookie found."]
  }

  const accountCookie = headers["set-cookie"].find((c) => c.startsWith("acct="))
  const redirectUrl = headers["location"][0]

  if (!accountCookie) {
    throw [500, "No account cookie found."]
  }

  return { redirectUrl, accountCookie }
}

app.use(bodyParser.urlencoded({ extended: false }))
app.use("/images", express.static(__dirname + "/images"))

app.get("/", (req, res) => {
  writeHelper(req, res)
})

app.use((req, res, next) => {
  const { origin } = req.headers
  const inWhitelist =
    originWhitelist.length === 0 || originWhitelist.indexOf(origin) !== -1
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
      // https://stackoverflow.com/oauth?client_id=
      return fetch(loginUrl, { redirect: "manual" })
    })
    // Load login form to get providence cookie
    .then((r) => getLoginPage(r))
    // Submit login form to get account cookie
    .then((html) =>
      submitLoginForm({ html, providenceCookie, email, password })
    )
    .then(async ([rawHeaders, html]) => {
      let { accountCookie, redirectUrl } = validateLoginResult({
        html,
        headers: rawHeaders,
      })

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
    .catch((e) => handleError(res, e))
})

app.post("/access-token", (req, res) => {
  const { email, password } = req.body
  const redirect =
    req.protocol + "://" + req.get("host") + "/access-token/success"
  const params = new URLSearchParams({
    client_id: process.env.STACK_APP_CLIENT_ID,
    redirect_uri: redirect,
  }).toString()
  const oauthUrl = "https://stackoverflow.com/oauth?" + params
  let providenceCookie = ""

  // https://api.stackexchange.com/docs/authentication
  // Explicit OAuth 2.0 flow consists of 4 steps:

  // 1. Send a user to https://stackoverflow.com/oauth, with these query string parameters
  //    client_id, scope, redirect_uri, state
  console.log("GET", oauthUrl)
  fetch(oauthUrl, { redirect: "manual" })
    // Load login form
    // https://stackoverflow.com/users/login?returnurl=
    .then((r) => getLoginPage(r))
    // 2. The user approves your app
    .then(([html, providenceCookie]) =>
      // Submit login form to get account cookie
      submitLoginForm({ html, providenceCookie, email, password })
    )
    .then(async ([rawHeaders, html]) => {
      const { redirectUrl, accountCookie } = validateLoginResult({
        html,
        headers: rawHeaders,
      })

      const headers = {
        Cookie: `${providenceCookie}; ${accountCookie}`,
      }
      console.log("GET", redirectUrl)
      // 3. The user is redirected to redirect_uri, with these query string parameters
      //    code, state
      // https://stackoverflow.com/oauth?client_id=
      const r = await fetch(redirectUrl, { headers, redirect: "manual" })
      const redirectUri = r.headers.get("location")
      const code = new URLSearchParams(redirectUri.split("?")[1]).get("code")
      const body = new URLSearchParams({
        client_id: process.env.STACK_APP_CLIENT_ID,
        client_secret: process.env.STACK_APP_CLIENT_SECRET,
        redirect_uri: redirect,
        code,
      })
      const url = "https://stackoverflow.com/oauth/access_token/json"
      console.log("POST", url)
      // 4. POST (application/x-www-form-urlencoded) the following parameters to
      //    https://stackoverflow.com/oauth/access_token/json
      return fetch(url, { method: "POST", body })
    })
    .then((r) => r.json())
    .then((json) => res.send(json))
    .catch((e) => handleError(res, e))
})

app.post("/query/run/:siteId/:queryId/:revisionId", (req, res) => {
  // siteId: https://data.stackexchange.com/sites
  const { siteId, queryId, revisionId } = req.params
  const url = `https://data.stackexchange.com/query/run/${siteId}/${queryId}/${revisionId}`
  const body = new URLSearchParams(req.body)
  const Cookie = req.headers["auth-cookie"]

  if (!Cookie) {
    handleError(res, [400, "No auth-cookie found in the request headers"])
    return
  }
  const headers = { Cookie }

  // I'm not a back-end developer (yet?), and it's not the cleanest code I've written but at least it works for now
  fetch(url, { method: "POST", body, headers })
    .then((r) => r.json())
    .then((json) => {
      if (json.error) {
        throw [400, json.error]
      }

      const { job_id } = json
      if (!job_id) {
        return res.send(json)
      }

      // the operation takes some time and the result is not in cache. Polling
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
    .catch((e) => handleError(res, e))
})

app.listen(port, () => console.log(`Listening on port ${port}`))
