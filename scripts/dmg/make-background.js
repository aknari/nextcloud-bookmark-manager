'use strict'
// Genera el fondo del DMG: renderiza background.html a 660x400 y lo captura a PNG.
const { app, BrowserWindow } = require( 'electron' )
const path = require( 'path' )
const fs = require( 'fs' )

app.whenReady().then( async () => {

	const win = new BrowserWindow({ show: false, width: 660, height: 400, webPreferences: { offscreen: true } })

	await win.loadFile( path.join( __dirname, 'background.html' ) )

	const image = await win.webContents.capturePage()

	fs.writeFileSync( path.join( __dirname, 'background.png' ), image.toPNG() )

	console.log( 'background.png written' )

	app.exit( 0 )

}).catch( e => { console.error( e.message ); app.exit( 1 ) })
