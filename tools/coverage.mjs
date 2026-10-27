// Runs the unit tests under c8 and makes the Cobertura report loadable by the
// Jenkins Coverage plugin. Extra arguments are passed on to `node --test`.
//
// c8 names every arrow function in the command tables (`format: (raw) => ...`)
// "format", and the plugin rejects a class with two methods of the same name
// ("There is already the same child [METHOD] format()V"). Duplicated names get
// the first line number appended to make them unique.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const REPORT = 'coverage/cobertura-coverage.xml'

const run = spawnSync('npx', ['c8', 'node', '--test', ...process.argv.slice(2)], { stdio: 'inherit' })

try {
	const xml = readFileSync(REPORT, 'utf8')
	const out = xml.replace(/<class\b[\s\S]*?<\/class>/g, (cls) => {
		const methods = cls.match(/<method name="[^"]*"/g) ?? []
		const seen = new Map()
		for (const m of methods) seen.set(m, (seen.get(m) ?? 0) + 1)
		return cls.replace(
			/<method name="([^"]*)"([^>]*)>(\s*<lines>\s*<line number="(\d+)")/g,
			(all, name, rest, tail, line) =>
				seen.get(`<method name="${name}"`) > 1 ? `<method name="${name}@${line}"${rest}>${tail}` : all,
		)
	})
	writeFileSync(REPORT, out)
} catch (err) {
	// no report, e.g. c8 itself failed to start: its exit status below says why
	if (err.code !== 'ENOENT') throw err
}

process.exit(run.status ?? 1)
