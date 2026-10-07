'use strict'

const {
	app,
	Menu,
	shell
} = require( 'electron' )

const path 			= require('path')
const log			= require( 'electron-log' )
const Store			= require( 'electron-store' )

const about 		= require('./about.min')
const favicons  	= require('./favicons.min')



module.exports.menuApp = function () {
	
	let store
	try {
		store = new Store()
	} catch(e) {
		store = { get: () => null }
	}
	
	const name 			= 'Nextcloud Bookmark Manager'
	
	const i18n = require('./i18n.min')
	
	const template = [
		{
			label: name,
			submenu: [
				{
					label: i18n.t('menu:app.name', 'About {{name}}', { name: name }),
					click() { about.createAbout() }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:app.login', 'Log in/out to Nextcloud…'),
					accelerator: 'Command+Ctrl+Alt+l',
					click (item, focusedWindow) {
						
						if( focusedWindow ) {
							
							// Use executeJavaScript instead of webContents.send (broken in Electron v34 with contextIsolation: false)
							const loginUrl = 'file://' + path.join(__dirname, '../html/login.html')
							
							focusedWindow.webContents.executeJavaScript(`
								(function() {
									try {
										const mw = require('../js/modal.min');
										mw.openModal('${loginUrl}', 480, 180, false);
										return 'open-modal called';
									} catch(e) {
										try {
											require('electron').ipcRenderer.send('error-in-render', {
												error: 'ej-openModal: ' + e.message + ' stack: ' + e.stack,
												url: 'menu-app.js',
												line: 0
											});
										} catch(e2) {}
										return 'error: ' + e.message;
									}
								})()
							`).then((result) => {
								// open-login executed
							}).catch((err) => {
								// login modal failed to open
							})
						}
					}
				},
				{
					type: 'separator'
				},
				{
					role: 'services',
					submenu: []
				},
				{
					type: 'separator'
				},
				{
					role: 'hide'
				},
				{
					role: 'hideothers'
				},
				{
					role: 'unhide'
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:app.quit', 'Quit {{name}}', { name: name }),
					accelerator: 'Command+q',
					click () { app.emit('quit-app') }
				}
			]
		},
		{
			label: i18n.t('menu:bookmarks.bookmarks', 'Bookmarks'),
			submenu:
			[
				{
					label: i18n.t('menu:bookmarks.new', 'Add New Bookmark…'),
					accelerator: 'Command+N',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('add-bookmark', 'add-bookmark') }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.edit', 'Edit Bookmark…'),
					accelerator: 'Command+E',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('edit-bookmark', 'edit-bookmark') }
				},
				{
					label: i18n.t('menu:bookmarks.delete', 'Delete Bookmark…'),
					accelerator: 'Command+D',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('delete-bookmark', 'delete-bookmark') }
				},
				{
					label: i18n.t('menu:bookmarks.deleteselected', 'Delete Selected Bookmarks…'),
					accelerator: 'Command+Shift+D',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('delete-selected-bookmarks', 'delete-selected-bookmarks') }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.newfolder', 'New Folder…'),
					accelerator: 'Command+Alt+N',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('new-folder', 'new-folder') }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.sync', 'Sync all Bookmarks'),
					accelerator: 'Cmd+R',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('refresh-bookmarks', 'refresh-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.favicons', 'Regenerate Favicons'),
					click ( item, focusedWindow ) { favicons.regenerate( focusedWindow.id ) }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.broken', 'Check Broken Links…'),
					accelerator: 'Command+Shift+B',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('check-broken-links', 'check-broken-links') }
				},
				{
					label: i18n.t('menu:bookmarks.cleanupempty', 'Clean Up Empty Folders…'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('clean-empty-folders', 'clean-empty-folders') }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.import', 'Import Bookmarks File…'),
					accelerator: 'Command+Alt+I',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('import-bookmarks', 'import-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.export', 'Export Bookmarks File…'),
					accelerator: 'Command+Alt+E',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('export-bookmarks', 'export-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.exportaz', 'Export Bookmarks File (A–Z)…'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('export-bookmarks-az', 'export-bookmarks-az') }
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.selectall', 'Select All'),
					accelerator: 'Command+Shift+A',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('select-all-bookmarks', 'select-all') }
				},
				{
					label: i18n.t('menu:bookmarks.deselectall', 'Deselect All'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('deselect-all-bookmarks', 'deselect-all') }
				},
				{
					type: 'separator'
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:bookmarks.autotag', 'Auto-Tag Bookmarks…'),
					accelerator: 'Command+Alt+T',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('auto-tag-bookmarks', 'auto-tag-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.autoorg', 'Auto-Organize Bookmarks…'),
					accelerator: 'Command+Alt+O',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('auto-organize-bookmarks', 'auto-organize-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.learn', 'Learn Folder Structure…'),
					accelerator: 'Command+Alt+L',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('learn-folder-structure', 'learn-folder-structure') }
				},
				{
					label: i18n.t('menu:bookmarks.repairtitles', 'Repair Titles…'),
					accelerator: 'Command+Alt+R',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('repair-titles-bookmarks', 'repair-titles-bookmarks') }
				},
				{
					label: i18n.t('menu:bookmarks.ai', 'AI Settings…'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('open-ai-config', 'open-ai-config') }
				}
			]  
		},
		{
			label: i18n.t('menu:edit.edit', 'Edit'),
			submenu: [
				{
					role: 'undo'
				},
				{
					role: 'redo'
				},
				{
					type: 'separator'
				},
				{
					role: 'cut'
				},
				{
					role: 'copy'
				},
				{
					role: 'paste'
				},
				{
					role: 'delete'
				},
				{
					role: 'selectall'
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:edit.find', 'Find…'),
					accelerator: 'Command+F',
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('find', 'find') }
				}
			]
		},
		{
			label: i18n.t('menu:view.view', 'View'),
			submenu:
			[
				//@exclude
				{
					label: 'Toggle Developer Tools',
					accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
					click (item, focusedWindow) {
						if (focusedWindow) focusedWindow.webContents.toggleDevTools()
					}
				},
				{
					type: 'separator'
				},
				//@end
				{
					role: 'resetzoom'
				},
				{
					role: 'zoomin'
				},
				{
					role: 'zoomout'
				},
				{
					type: 'separator'
				},
				{
					role: 'togglefullscreen'
				},
				{
					type: 'separator'
				},
				{
					type: 'checkbox',
					label: i18n.t('menu:view.sortalpha', 'Sort Bookmarks A–Z'),
					checked: !!store.get('sortBookmarksAZ'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('sort-alpha-toggle', item.checked) }
				}
			]
		},
		{
			label: i18n.t('menu:window.window', 'Window'),
			role: 'window',
			submenu:
			[
				{
					label: i18n.t('menu:window.close', 'Close'),
					accelerator: 'CmdOrCtrl+W',
					role: 'close'
				},
				{
					label: i18n.t('menu:window.minimize', 'Minimize'),
					accelerator: 'CmdOrCtrl+M',
					role: 'minimize'
				},
				{
					label: i18n.t('menu:window.zoom', 'Zoom'),
					role: 'zoom'
				},
				{
					type: 'separator'
				},
				{
					label: i18n.t('menu:window.front', 'Bring All to Front'),
					role: 'front'
				}
			]
		},
		{
			label: i18n.t('menu:help.help', 'Help'),
			role: 'help',
			submenu:
			[
				{
					label: i18n.t('menu:help.homepage', 'Nextcloud Bookmark Manager Homepage'),
					click () { require('electron').shell.openExternal('https://www.midwinter-dg.com/mac-apps/nextcloud-bookmark-manager.html?app') }
				}
			]
		}
	]
	
	
	const menu = Menu.buildFromTemplate(template)
	Menu.setApplicationMenu(menu)
}
