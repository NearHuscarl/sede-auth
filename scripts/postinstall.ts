const md = require('markdown-it')()
const fs = require('fs').promises

function generateHtmlReadme() {
	fs.readFile('./README.md', "utf8")
		.then(data => {
				const html = md.render(data)
				fs.writeFile('./README.html', html)
		})
}

generateHtmlReadme()