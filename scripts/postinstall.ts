const fs = require("fs").promises
const highlight = require("highlight.js")
const emoji = require("markdown-it-emoji")
const md = require("markdown-it")({
  html: true,
  highlight: function (str, lang) {
    lang = languageMapper(lang)
    if (lang && highlight.getLanguage(lang)) {
      try {
        return highlight.highlight(lang, str).value
      } catch (__) {}
    }

    return "" // use external default escaping
  },
})

md.use(emoji)

function languageMapper(lang: string) {
  switch (lang) {
    case "json5":
      return "json"
    default:
      return lang
  }
}

function getDocument(content: string) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/4.0.0/github-markdown.min.css" integrity="sha512-Oy18vBnbSJkXTndr2n6lDMO5NN31UljR8e/ICzVPrGpSud4Gkckb8yUpqhKuUNoE+o9gAb4O/rAxxw1ojyUVzg==" crossorigin="anonymous" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.3.1/styles/github.min.css" integrity="sha512-7QTQ5Qsc/IL1k8UU2bkNFjpKTfwnvGuPYE6fzm6yeneWTEGiA3zspgjcTsSgln9m0cn3MgyE7EnDNkF1bB/uCw==" crossorigin="anonymous" />
    <style>
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
    }
    
    @media (max-width: 767px) {
      .markdown-body {
        padding: 15px;
      }
    }
    </style>
   </head>
  <body class="markdown-body">
    ${content}
  </body>
</html>
`
}

function generateHtmlReadme() {
  fs.readFile("./README.md", "utf8").then((data) => {
    const body = md.render(data)
    fs.writeFile("./README.html", getDocument(body))
  })
}

generateHtmlReadme()
