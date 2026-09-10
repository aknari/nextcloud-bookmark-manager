'use strict'

const {app, BrowserWindow, ipcMain, protocol, Menu, dialog} = require( 'electron' )
const url 				= require( 'url' ) 
const path 				= require( 'path' )
const Store 			= require( 'electron-store' )
const log				= require( 'electron-log' )
const detectBrowsers	= require( 'detect-browsers' )

const menuApp 			= require( './menu-app.min' )
const menuTable 		= require( './menu-table.min' )
const menuSidebar 		= require( './menu-sidebar.min' )
const menuTray 			= require( './menu-tray.min' )

const favicons 			= require( './favicons.min' )

// Register 'nc' as a privileged scheme so protocol.handle can intercept redirects
protocol.registerSchemesAsPrivileged([
	{ scheme: 'nc', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// Disable web security BEFORE any other Electron operation so browser fetch() works
// from file:// URLs without CORS restrictions. This must be as early as possible.
app.commandLine.appendSwitch('disable-web-security')

const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

app.name = 'Nextcloud Bookmark Manager'

let win,
	loginFlow,
	isQuitting = false


let store = new Store({
	name: 'config',
	defaults: {
		
		windowBounds: {
			width: 1000,
			height: 700,
			x: 0,
			y: 0
		},
		
		tableColumns: {
			
			description: false,
			url: false,
			created: true,
			modified: true,
			folders: false,
			tags: true,
			favicon: true
		},
		
		loginCredentials: {
			
			server: '',
			username: '',
			password: ''
		},
		
		exportPath: app.getPath('desktop'),
		dirPath: app.getPath( 'appData' ) + '/' + app.name,
		tags: null,
		folders: null,
		browsers: null,
		defaultIcons: []
	}
})

let bookmarkFile = new Store({
	name: 'bookmarks',
	defaults: {
		data: null
	}
})





function createWindow() {
	
	let { x, y, width, height } = store.get('windowBounds')
	
	win = new BrowserWindow({
		show: false,
		x: x,
		y: y,
		width: width,
		height: height,
		minWidth: 550,
		minHeight: 544,
		vibrancy: 'under-window',
		webPreferences: {
			devTools: true,
			nodeIntegration: true,
			contextIsolation: false,
			preload: path.join(__dirname, './preload.min.js')
		}
	})
	
	remoteMain.enable(win.webContents)
	
	//note(dgmid): single-window app — deny any attempt to open extra windows
	//(Shift/Cmd/Alt-click or middle-click on <a href="#"> links would otherwise
	//spawn a new BrowserWindow without nodeIntegration, rendering an empty app shell)
	win.webContents.setWindowOpenHandler( () => ({ action: 'deny' }) )
	
	function saveWindowBounds() {
		
		store.set('windowBounds', win.getBounds())
	}
	
	win.loadURL(url.format ({
		
		pathname: path.join(__dirname, '../html/app.html'), 
		protocol: 'file:',
		slashes: true 
	}))
	
	win.once('ready-to-show', () => {
		
		win.show()
	})
	
	win.on('resize', saveWindowBounds)
	win.on('move', saveWindowBounds)
	
	win.on('blur', () => {
		
		win.webContents.send('state', 'blur')
	})
	
	win.on('focus', () => {
		
		win.webContents.send('state', 'focus')
	})
	
	app.on('before-quit', () => {
		
		isQuitting = true
	})
	
	win.on('close', function(e) {
	
		if( !isQuitting ) {
			
			e.preventDefault()
			Menu.sendActionToFirstResponder('hide:')
		}
	})
	
	win.webContents.on('did-fail-load', () => {
		
		log.error( `main window did not load` )
	})
	
	win.webContents.on( 'crashed', ( event, killed ) => {
		
		log.info( `main window has crashed:` )
		log.error( event )
	})
	
	win.on( 'unresponsive', () => {
		
		log.info( `main window is not responding…` )
	})
	
	win.on( 'responsive', () => {
		
		log.info( `main window is responding` )
	})
	
	detectBrowsers.getAvailableBrowsers()
	.then(browsers => {
		
		store.set('browsers', browsers )
	
	})
	.catch( error => log.error(error) )
	
	menuApp.menuApp()
	menuTable.menuBookmarks( win.id )
	menuTable.menuColumns( win.id )
	menuTable.menuPanels( win.id )
	menuSidebar.menuFolders( win.id )
	menuSidebar.menuTags( win.id )
	menuTray.menuTray( win.id )

}



app.on('ready', function() {
	
	createWindow()
	
	// Intercept nc:// protocol redirect from Nextcloud Login Flow
	protocol.handle('nc', (request) => {
		
		const url = request.url
		
		if( url ) {
			
			const parts = url.split( '&' )
			
			const 	user = parts[1].replace('user:', ''),
					pass = parts[2].replace('password:', '')
			
			store.set( 'loginCredentials.username', decodeURIComponent(user) )
			store.set( 'loginCredentials.password', pass )
			
			loginFlow.close()
			
			// Execute JavaScript in the main window to:
			// 1. Close the login modal
			// 2. Send IPC to trigger a full reload (so app.js module-level code re-runs with credentials)
			win.webContents.executeJavaScript(`
				require('../js/modal.min').closeModal();
				require('electron').ipcRenderer.send('trigger-reload', '');
			`).then(() => {
				// reload IPC sent from renderer
			}).catch((err) => {
				// Fallback: reload the page directly
				win.webContents.reload()
			})
		}
		
		return new Response()
	})
}) 



app.on('window-all-closed', function () {
	
	if (process.platform !== 'darwin') {
		
		app.quit()
	}
})



app.on('activate', ( event, hasVisibleWindows ) => {
	
	if (!hasVisibleWindows) {
		
		createWindow()
	}
})



app.on('quit-app', () => {
	
	isQuitting = true
	app.quit()
})



// IPC: close current window (called from modals)
ipcMain.on('close-current-window', (event) => {
	
	BrowserWindow.fromWebContents( event.sender ).close()
})


// IPC: close a specific modal window by ID (called from app.js via modalWindow.closeModal)
ipcMain.on('close-modal-window', (event, modalId) => {
	
	const modalWin = BrowserWindow.fromId( modalId )
	
	if( modalWin ) {
		
		modalWin.close()
	}
})


// IPC: open modal window (using send/on instead of invoke/handle for Electron v34 compat)
ipcMain.on('open-modal', (event, { url, width, height, resize }) => {
	
	const modal = new BrowserWindow({
		
		parent: BrowserWindow.fromWebContents( event.sender ),
		modal: true,
		width: width,
		minWidth: width,
		maxWidth: width,
		height: height,
		minHeight: height,
		resizable: resize,
		show: false,
		frame: false,
		backgroundColor: '#f0f0f0',
		webPreferences: {
			devTools: true,
			nodeIntegration: true,
			contextIsolation: false,
			preload: path.join(__dirname, './preload.min.js')
		}
	})
	
	remoteMain.enable(modal.webContents)
	
	// Send modal ID immediately so the renderer has it even if page load fails
	event.sender.send( 'open-modal-response', modal.id )
	
	modal.loadURL( url )
	
	modal.once('ready-to-show', () => {
		
		modal.show()
	})
	
	modal.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
		// log failure silently
	})
	
	modal.on('unresponsive', () => {
		// log unresponsive silently
	})
})


// IPC: show error dialog
ipcMain.on('show-error-box', (event, { title, content }) => {
	
	dialog.showErrorBox( title, content )
})


// IPC: relay degraded-mode status changes (sent by fetch.js from any window) to
// the main window so the banner can be shown/hidden live
ipcMain.on('server-status-changed', (event, status) => {
	
	if( win && !win.isDestroyed() ) win.webContents.send( 'server-status-changed', status )
})


// IPC: continue offline — close the login modal and tell the main window to load
// the local mirror in read-only mode (no credentials needed)
ipcMain.on('continue-offline', (event) => {
	
	const loginWin = BrowserWindow.fromWebContents( event.sender )
	if( loginWin ) loginWin.close()
	
	if( win && !win.isDestroyed() ) win.webContents.send( 'continue-offline' )
})


// IPC: show message box (synchronous, returns button index)
ipcMain.on('show-message-box', (event, options) => {
	
	const win = BrowserWindow.fromWebContents( event.sender )
	event.returnValue = dialog.showMessageBoxSync( win, options )
})


// IPC: show save dialog (async)
ipcMain.handle('show-save-dialog', async (event, options) => {
	
	const win = BrowserWindow.fromWebContents( event.sender )
	return await dialog.showSaveDialog( win, options )
})


// IPC: show open dialog (async, used for import)
ipcMain.handle('show-open-dialog', async (event, options) => {
	
	const win = BrowserWindow.fromWebContents( event.sender )
	return await dialog.showOpenDialog( win, options )
})


// IPC: get app version (sync, used by version.js at module load)
ipcMain.on('get-version', (event) => {
	
	event.returnValue = app.getVersion()
})



ipcMain.on('refresh', (event, message) => {
	
	//note(dgmid): forward the payload so the main window can distinguish
	//"refresh after edit" (with the edited bookmark) / "refresh after auto-tag"
	//(with the applied tags) from plain/structural refreshes.
	win.webContents.send('refresh-bookmarks', message)
})



// IPC: get (or generate) a favicon for a bookmark on demand
ipcMain.handle('get-favicon', async (event, { id, url }) => {
	
	return await favicons.getFaviconPath( id, url )
})


ipcMain.on('update-favicon', (event, message) => {
	
	favicons.generate( win.id, message, false )
})


ipcMain.on('loginflow', (event, message) => {
	
	loginFlow = new BrowserWindow({
		
		width: 800,
		height: 600,
		resizable: false,
		minimizable: false,
		maximizable: false,
		show: false,
		titleBarStyle: 'hidden',
		backgroundColor: '#0082c9',
		webPreferences: {
			devTools: true,
			nodeIntegration: false,
			contextIsolation: true
		}
	})
	
	// Strip trailing slash from server URL to avoid double slash
	let serverUrl = message
	if( serverUrl.endsWith('/') ) serverUrl = serverUrl.slice(0, -1)
	
	loginFlow.loadURL( serverUrl + '/index.php/login/flow' , {
		
		userAgent: 'Nextcloud Bookmark Manager - Macintosh',
		extraHeaders: 'OCS-APIRequest: true'
	})
	
	loginFlow.once('ready-to-show', () => {
		
			loginFlow.show()
	})
	
	loginFlow.webContents.on('did-fail-load', (e, errorCode, errorDescription) => {
		
		log.error( `loginflow window did not load` )
	})
	
	loginFlow.webContents.on( 'crashed', ( event, killed ) => {
		
		log.info( `loginflow window has crashed:` )
		log.error( event )
	})
	
	loginFlow.on( 'unresponsive', () => {
		
		log.info( `loginflow window is not responding…` )
	})
	
	loginFlow.on( 'responsive', () => {
		
		log.info( `loginflow window is responding` )
	})
})



// IPC: triggered from renderer via executeJavaScript after nc: login flow succeeds
// The critical credentials check in app.js runs at MODULE LEVEL (not inside $(document).ready),
// so win.webContents.reload() is sufficient - module-level code always executes on script load.
ipcMain.on('trigger-reload', function() {
	
	win.webContents.reload()
})



ipcMain.on('error-in-render', function(event, message) {
	
	log.error(`exception in render process:`)
	log.info (message)
})
