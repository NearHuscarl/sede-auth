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

  if (redirectUrl.startsWith("https://stackoverflow.com/nocaptcha")) {
    throw [400, `Require captcha: ${redirectUrl}`]
  }

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

function pollJob(jobId, onSuccess, onTimeout) {
  // the operation takes some time and the result is not in cache. Polling
  console.log(`start polling job: ${jobId}`)

  const pollInterval = 1000
  const pollTimeout = 10_000
  const before = Date.now()

  async function poll() {
    if (Date.now() - before > pollTimeout) {
      return onTimeout({ error: `Response timeout after ${pollTimeout}ms` })
    }

    const url = `https://data.stackexchange.com/query/job/${jobId}?=${Date.now()}`
    console.log("GET", url)
    const json = await fetch(url).then((r) => r.json())
    if (json.running) {
      setTimeout(poll, pollInterval)
    } else {
      onSuccess(json)
    }
  }

  setTimeout(poll, pollInterval)
}

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

  fetch(url, { method: "POST", body, headers })
    .then((r) => r.json())
    .then((json) => {
      if (json.error) {
        throw [400, json.error]
      }
      if (json.captcha) {
        throw [500, "Need captcha, you may want to logout and login again"]
      }

      const { job_id } = json
      if (!job_id) {
        return res.send(json)
      }

      pollJob(job_id, res.send, (error) => res.status(503).send(error))
    })
    .catch((e) => handleError(res, e))
})

app.post("/query/save/:siteId/:queryId", (req, res) => {
  const { siteId, queryId } = req.params
  const url = `https://data.stackexchange.com/query/save/${siteId}/${queryId}`
  const body = new URLSearchParams(req.body)
  const Cookie = req.headers["auth-cookie"]

  if (!Cookie) {
    handleError(res, [400, "No auth-cookie found in the request headers"])
    return
  }
  const headers = { Cookie }

  fetch(url, { method: "POST", body, headers })
    .then((r) => r.json())
    .then((json) => {
      if (json.error) {
        throw [400, json.error]
      }
      if (json.captcha) {
        throw [500, "Need captcha, you may want to logout and login again"]
      }

      const sendResult = (json) => {
        const { revisionId } = json
        res.send({ revisionId })
      }

      const { job_id } = json
      if (!job_id) {
        return sendResult(json)
      }

      pollJob(job_id, sendResult, (error) => res.status(503).send(error))
    })
    .catch((e) => handleError(res, e))
})

app.listen(port, () => console.log(`Listening on port ${port}`))
