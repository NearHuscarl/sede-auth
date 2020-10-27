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
    <link rel="stylesheet" href="/github-markdown.css">
    <link rel="stylesheet" href="/github.css">
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
