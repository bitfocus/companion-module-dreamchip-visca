import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'
import globals from 'globals'

const baseConfig = await generateEslintConfig({})

export default [
	...baseConfig,
	{
		files: ['**/*.js', '**/*.mjs'],
		languageOptions: {
			sourceType: 'module',
			globals: globals.node,
		},
		rules: {
			// formatting is advisory for now (see Jenkinsfile lint stage), not a hard error
			'prettier/prettier': 'warn',
			'no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
		},
	},
	{
		// standalone CLI scripts exit with status codes
		files: ['tools/**'],
		rules: { 'n/no-process-exit': 'off' },
	},
]
