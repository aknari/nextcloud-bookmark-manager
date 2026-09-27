'use strict'
// Genera el DMG de release con fondo/posición/iconos (appdmg).
// Requiere que `npm run package` ya haya producido el .app en build/.
// Uso: node scripts/dmg/make-dmg.js
const path  = require( 'path' )
const fs    = require( 'fs' )
const appdmg = require( 'appdmg' )

const pkg = JSON.parse( fs.readFileSync( path.join( __dirname, '../../package.json' ), 'utf8' ) )

const target = path.join( __dirname, '../../build', `Nextcloud-Bookmark-Manager-${pkg.version}.dmg` )

if( fs.existsSync( target ) ) fs.unlinkSync( target )

const ee = appdmg({
	basepath: path.join( __dirname, '../..' ),
	target: target,
	specification: JSON.parse( fs.readFileSync( path.join( __dirname, 'appdmg.json' ), 'utf8' ) )
})

ee.on( 'finish', () => { console.log( `DMG written: ${target}` ); process.exit( 0 ) })

ee.on( 'error', e => { console.error( e.message ); process.exit( 1 ) })
