const express = require('express')
const bodyParser = require('body-parser')
const fetch = require('node-fetch')
const jsdom = require("jsdom");

const app = express()
const urlencodedParser = bodyParser.urlencoded({ extended: false })

function getWhitelist(req) {
    const dev = req.app.get('env')
    const whitelist = ['https://sotoolkit.netlify.app']
    if (dev) whitelist.push('http://localhost:3000')
    return whitelist
}

app.use((req, res, next) => {
    const { origin } = req.headers
    if (getWhitelist(req).indexOf(origin) === -1) {
        res.writeHead(403, 'Forbidden', req.headers);
        res.end('The origin "' + origin + '" was not whitelisted by the operator of this proxy.');
        return
    }

    res.header("Access-Control-Allow-Origin", "*");
    res.header('Access-Control-Allow-Methods', 'DELETE, PUT');
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if ('OPTIONS' === req.method) {
        res.sendStatus(200);
    } else {
        next();
    }
});

// thank you very much Glorfindel
// https://meta.stackexchange.com/questions/264678/please-provide-a-way-to-download-sede-data-via-an-api/341993?noredirect=1#comment1189215_341993
app.post('/auth', urlencodedParser, (req, res) => {
    const { email, password } = req.body
    const authUrl = 'https://data.stackexchange.com/user/authenticate'
    const body = new URLSearchParams('oauth2url=https://stackoverflow.com/oauth&openid=')
    let providenceCookie = ''

    console.log('POST', authUrl)
    fetch(authUrl, { method: 'POST', body, redirect: 'manual' }).then(r => {
        const headers = r.headers.raw()
        const loginUrl = headers['location'][0]
        console.log('GET', loginUrl)
        return fetch(loginUrl, { redirect: 'manual' })
    }).then(r => {
        const rawHeaders = r.headers.raw()
        providenceCookie = rawHeaders['set-cookie'].find(c => c.startsWith('prov='))
        const loginUrl = rawHeaders['location'][0]
        const headers = {
            Cookie: providenceCookie,
        }
        console.log('GET', loginUrl)

        if (!providenceCookie) {
            throw new Error("No providence cookie found.")
        }

        return fetch(loginUrl, { headers })
    }).then(r => r.text()).then(text => {
        const dom = new jsdom.JSDOM(text);
        const { document } = dom.window
        const actionUrl = document.getElementById('login-form').getAttribute('action')
        const headers = { Cookie: providenceCookie }
        const body = new URLSearchParams({
            fkey: document.querySelector("input[name='fkey']").value,
            email,
            password,
        })
        const url = 'https://stackoverflow.com' + actionUrl
        console.log('POST', url)

        return fetch(url, { method: 'POST', body, headers, redirect: 'manual' })
    }).then(async r => {
        const rawHeaders = r.headers.raw()
        const accountCookie = rawHeaders['set-cookie'].find(c => c.startsWith('acct='))
        let redirectUrl = rawHeaders['location'][0]

        if (!accountCookie) {
            throw new Error("No account cookie found.");
        }

        // OAuth2 redirection
        // 1. https://stackoverflow.com/oauth?client_id=...
        // 2. http://data.stackexchange.com/user/oauth/stackapps?code=...
        // 3. https://data.stackexchange.com/user/oauth/stackapps?code=...
        for (let i = 1; i <= 3; i++) {
            console.log('GET', redirectUrl)
            const headers = {
                Cookie: i === 1 ? `${providenceCookie}; ${accountCookie}` : providenceCookie,
            }
            const r = await fetch(redirectUrl, { headers, redirect: 'manual' })
            const rawHeaders = r.headers.raw()

            if (i === 3) {
                return rawHeaders['set-cookie'].find(c => c.startsWith('.ASPXAUTH='))
            } else {
                redirectUrl = rawHeaders['location'][0]
            }
        }
    }).then((authenticationCookie) => {
        res.send({ authenticationCookie })
    })
})

app.listen(8080, () => console.log('Listening on port 8080'))
