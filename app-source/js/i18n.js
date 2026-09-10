'use strict'

const i18n = require( 'i18next' )
const i18nextBackend = require( 'i18next-sync-fs-backend' )
const path = require( 'path' )

// Custom language detector (i18next-electron-language-detector requires app from renderer, which doesn't work in modern Electron)
const LanguageDetector = {
	type: 'languageDetector',
	detect: () => {
		// Renderer: use navigator.language / Main: use app.getLocale()
		if( typeof navigator !== 'undefined' && navigator.language ) {
			return navigator.language
		}
		try {
			const { app } = require( 'electron' )
			return app.getLocale()
		} catch( e ) {
			return 'en'
		}
	},
	init: () => {},
	cacheUserLanguage: () => {}
}


const i18nextOptions = {

	fallbackLng: 'en',
	debug: false,
	ns: [
		'about',
		'app',
		'addbookmark',
		'addfolder',
		'bookmarktable',
		'checkbroken',
		'date',
		'editbookmark',
		'editfolder',
		'edittag',
		'export',
		'favicons',
		'fetch',
		'findduplicates',
		'import',
		'login',
		'menu',
		'menusidebar',
		'menutable',
		'version',
		'autoorg',
		'autotag',
		'aiconfig',
		'learn',
		'repairtitles'
		],
	defaultNS: 'app',
	backend:{
		loadPath: path.join(__dirname, '../i18n/{{lng}}/{{ns}}.json'),
		addPath: path.join(__dirname, '../i18n/{{lng}}/{{ns}}.missing.json'),
	jsonIndent: 2,
	},
	saveMissing: true,
	initImmediate: false
}



i18n.use(LanguageDetector).use(i18nextBackend)



if (!i18n.isInitialized) {

	i18n.init(i18nextOptions)
}



module.exports = i18n
