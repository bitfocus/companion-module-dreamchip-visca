// Rewrites the exported files of a release tree so they fit the public repo.
//
//   node tools/release-transform.mjs <tree> <version>
//
import fs from 'node:fs'
import path from 'node:path'

const [tree, version] = process.argv.slice(2)
if (!tree || !version) {
	console.error('usage: release-transform.mjs <tree> <version>')
	process.exit(2)
}
const file = (name) => path.join(tree, name)
const readJson = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const writeJson = (name, data, indent) => fs.writeFileSync(file(name), JSON.stringify(data, null, indent) + '\n')

const REPO = 'bitfocus/companion-module-dreamchip-visca'

// package.json: drop test/lint tooling (test/, eslint and c8 config are not shipped).
const pkg = readJson('package.json')
pkg.version = version
pkg.repository = { type: 'git', url: `git+https://github.com/${REPO}.git` }
pkg.scripts = { format: 'prettier --write src', package: pkg.scripts.package }
for (const dep of ['c8', 'eslint', 'eslint-formatter-checkstyle', 'globals']) delete pkg.devDependencies[dep]
writeJson('package.json', pkg, 2)

const manifest = readJson('companion/manifest.json')
manifest.version = version
manifest.repository = `git+https://github.com/${REPO}.git`
manifest.bugs = `https://github.com/${REPO}/issues`
writeJson('companion/manifest.json', manifest, 2)

// README.md: the Cloning section is the internal Gerrit workflow.
let readme = fs.readFileSync(file('README.md'), 'utf8')
const cloning = /^## Cloning\n[\s\S]*?(?=^## )/m
if (!cloning.test(readme)) throw new Error('README.md: "## Cloning" section not found')
readme = readme.replace(cloning, '')
fs.writeFileSync(file('README.md'), readme)
