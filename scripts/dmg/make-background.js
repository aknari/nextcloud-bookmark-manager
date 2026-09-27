'use strict'
// Genera el fondo del DMG: renderiza background.html y captura a PNG.
// Produce dos ficheros: background.png (660x400) y background@2x.png (1320x800,
// captura Retina que appdmg usa automáticamente en pantallas HiDPI).
const { app, BrowserWindow } = require( 'electron' )
const path = require( 'path' )
const fs = require( 'fs' )
const { execFileSync } = require( 'child_process' )

const W = 660, H = 400

app.whenReady().then( async () => {

	const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } })

	await win.loadFile( path.join( __dirname, 'background.html' ) )

	const image = await win.webContents.capturePage()

	const raw = image.getSize()

	//note: on Retina the capture comes out 2x (1320x800) — keep it as the @2x asset
	//and downsample to the 1x size with sips. On a 1x screen there is no @2x file.
	fs.writeFileSync( path.join( __dirname, 'background.png' ), image.toPNG() )

	if( raw.width === W * 2 && raw.height === H * 2 ) {

		fs.writeFileSync( path.join( __dirname, 'background@2x.png' ), image.toPNG() )

		execFileSync( 'sips', [ '-z', String( H ), String( W ), path.join( __dirname, 'background.png' ) ], { stdio: 'ignore' } )

		console.log( `background.png written (${W}x${H}) + background@2x.png (${raw.width}x${raw.height})` )

	} else {

		try { fs.unlinkSync( path.join( __dirname, 'background@2x.png' ) ) } catch( e ) {}

		console.log( `background.png written (${raw.width}x${raw.height}, resampled to ${W}x${H})` )
	}

	app.exit( 0 )

}).catch( e => { console.error( e.message ); app.exit( 1 ) })
