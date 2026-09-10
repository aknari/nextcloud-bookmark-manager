'use strict'

const {
	app,
	BrowserWindow,
	Menu,
	MenuItem,
	ipcMain,
	shell,
	clipboard
} = require( 'electron' )

const Store 			= require( 'electron-store' )
const store 			= new Store()
const detectBrowsers 	= require('detect-browsers')

const entities 			= require( './entities.min' )
const log 				= require( 'electron-log' )



module.exports.menuBookmarks = function ( winId ) {
	
	const i18n = require('./i18n.min')
	
	ipcMain.on('show-bookmark-menu', ( event, message ) => {
		
		let rowData 		= message.row,
			selectedCount	= message.selectedCount || 1,
			id 				= rowData[0],
			title 			= entities.decode(rowData[2])
		
		// Use direct references for folder submenus to avoid hardcoded index issues
		let addFolderSubmenu = [],
			removeFolderSubmenu = []
		
		const bookmarkMenuTemplate = [
			{
				label: i18n.t('menutable:bookmarks.open', 'Open {{- title}} in Default Browser', { title: title }),
				click () { require('electron').shell.openExternal( rowData[4] ) }
			},
			{
				label: i18n.t('menutable:bookmarks.with', 'Open {{- title}} with…', { title: title }),
				submenu: []
			},
			{
				label: i18n.t('menutable:bookmarks.copy', 'Copy {{- title}} url to Clipboard', { title: title }),
				click () { clipboard.writeText(rowData[4], title) }	
			},
			{
				type: 'separator'
			},
			{
				label: i18n.t('menutable:bookmarks.edit', 'Edit {{- title}} Bookmark…', { title: title }),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('edit-bookmark', rowData) }
			},
			{
				label: i18n.t('menutable:bookmarks.delete', 'Delete {{- title}} Bookmark…', { title: title }),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('delete-bookmark', [id, title]) }
			},
			// If multiple bookmarks are selected, add a bulk delete option
			...( selectedCount > 1 ? [{
				label: i18n.t('menutable:bookmarks.deleteselected', 'Delete {{count}} Selected Bookmarks…', { count: selectedCount }),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('delete-selected-bookmarks', '') }
			}] : [] ),
			{
				type: 'separator'
			},
			{
				label: i18n.t('menutable:bookmarks.addtofolder', 'Add to Folder…'),
				submenu: addFolderSubmenu  // use direct reference
			},
			{
				label: i18n.t('menutable:bookmarks.removefromfolder', 'Remove from Folder…'),
				submenu: removeFolderSubmenu  // use direct reference
			},
			{
				type: 'separator'
			},
			{
				label: i18n.t('menutable:bookmarks.info', 'Show / Hide Info…'),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('info-bookmark', id) }
			},
		]
		
		let browsers = store.get( 'browsers' )
		
		for(let browser of browsers) {
			
			bookmarkMenuTemplate[1].submenu.push({
				label: browser.browser,
				click () {
					
					detectBrowsers.launchBrowser( browser, rowData[4] )
				}
			})
		}
		
		const 	folders 	= store.get( 'folders' ),
				folderIds 	= rowData[9].split( ',' ).map( Number )
		
		if( !folderIds.includes( -1 ) ) {
			
			addFolderSubmenu.push(
				{
					label: i18n.t('menutable:bookmarks.home', 'Home'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('move-bookmark',
						{
							'method': 'addtofolder',
							'bookmark_id': id,
							'folder_id': -1,
							'count': folderIds.length
						}
					)}
				},
				{
					type: 'separator'
				}
			)
		
		} else {
			
			removeFolderSubmenu.push(
				{
					label: i18n.t('menutable:bookmarks.home', 'Home'),
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('move-bookmark',
						{
							'method': 'deletefromfolder',
							'bookmark_id': id,
							'folder_id': -1,
							'count': folderIds.length
						}
					)}
				},
				{
					type: 'separator'
				}
			)
		}
		
		for( let folder of folders ) {
		
			if( !folderIds.includes( folder.id )  ) {
		
				addFolderSubmenu.push({
					
					label: folder.text,
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('move-bookmark',
						{
							'method': 'addtofolder',
							'bookmark_id': id,
							'folder_id': folder.id,
							'count': folderIds.length
						}
					)}
				})
			
			} else {
				
				removeFolderSubmenu.push({
					
					label: folder.text,
					click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('move-bookmark',
						{
							'method': 'deletefromfolder',
							'bookmark_id': id,
							'folder_id': folder.id,
							'count': folderIds.length
						}
					)}
				})
			}
		}
		
		
		const bookmarkMenu = Menu.buildFromTemplate( bookmarkMenuTemplate )
		
		const win = BrowserWindow.fromId( winId )
		bookmarkMenu.popup( win )
	})
}



module.exports.menuColumns = function ( winId ) {
	
	const i18n = require('./i18n.min')
	
	ipcMain.on('show-columns-menu', ( event, message ) => {
		
		let settings = store.get( 'tableColumns' )
		
		const columnsMenuTemplate = [
			{
				label: i18n.t('menutable:columns.description', 'Description'),
				type: 'checkbox',
				checked: settings.description,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 3,
						"name": "description",
						"state": settings.description
					}
				) }
			},
			{
				label: i18n.t('menutable:columns.url', 'Url'),
				type: 'checkbox',
				checked: settings.url,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 4,
						"name": "url",
						"state": settings.url
					}
				) }
			},
			{
				label: i18n.t('menutable:columns.created', 'Created'),
				type: 'checkbox',
				checked: settings.created,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 6,
						"name": "created",
						"state": settings.created
					}
				) }
			},
			{
				label: i18n.t('menutable:columns.modified', 'Modified'),
				type: 'checkbox',
				checked: settings.modified,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 8,
						"name": "modified",
						"state": settings.modified
					}
				) }
			},
			{
				label: i18n.t('menutable:columns.folders', 'Folders'),
				type: 'checkbox',
				checked: settings.folders,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 10,
						"name": "folders",
						"state": settings.folders
					}
				) }
			},
			{
				label: i18n.t('menutable:columns.tags', 'Tags'),
				type: 'checkbox',
				checked: settings.tags,
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-column',
					{
						"id": 11,
						"name": "tags",
						"state": settings.tags
					}
				) }
			}
		]
		
		const columnsMenu = Menu.buildFromTemplate( columnsMenuTemplate )
		
		const win = BrowserWindow.fromId( winId )
		columnsMenu.popup( win )
	})
}



module.exports.menuPanels = function ( winId ) {
	
	const i18n = require('./i18n.min')
	
	ipcMain.on('show-panels-menu', ( event, message ) => {
		
		const panelsMenuTemplate = [
			{
				label: i18n.t('menutable:panels.open', 'Open All'),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-info-panels', 'open') }
			},
			{
				label: i18n.t('menutable:panels.close', 'Close All'),
				click (item, focusedWindow) { if(focusedWindow) focusedWindow.webContents.send('toggle-info-panels', 'close') }
			}
		]
		
		const panelsMenu = Menu.buildFromTemplate( panelsMenuTemplate )
		
		const win = BrowserWindow.fromId( winId )
		panelsMenu.popup( win )
	})
}
