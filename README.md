# One Task

A tiny ordinary web app for trying model-driven testing in Edit. It has three task states and four exported actions. The application contains no TLA+ viewer, model checker, or action-to-model mappings.

## Run the app

```sh
npm run dev
```

The app listens on port 3000. It also works directly in Edit's file preview. Tests need no dependencies:

```sh
npm test
```

## Connect the existing TLA+ viewer

Open the app preview with `?devBridge=1` to enable its optional development bridge. Open the existing TLA+ State Explorer in a second browser pane in the same Edit project. The viewer can be hosted separately or run as a separate tool in the project; its code does not belong in the application.

In the viewer, choose **Open files → One Task**, open **Application**, discover the running app, and review these mappings before attaching:

| Model action | File | Function |
| --- | --- | --- |
| Add | src/task-app.js | addTask |
| Complete | src/task-app.js | completeTask |
| Reopen | src/task-app.js | reopenTask |
| Delete | src/task-app.js | deleteTask |
| Observe state | src/task-app.js | observe |
| Reset application | src/task-app.js | reset |

The viewer owns these mappings and compares real observations with model states. Rewinding resets the app and replays the selected prefix. Enable **Break Complete** in the app to see a mismatch: the model expects `done`, but the running app remains `open`.

`src/dev-bridge.js` exposes only registered live function references through a dedicated message channel. It does not evaluate source code, import a new application instance, or receive expected model states. It is inactive without the query flag. Reloading either preview requires reconnecting.

The sample `model/Task.tla` and `.cfg` are reference files. The app never loads them.

## Multiple apps in one Edit project

Edit supports independent shells and browser panes:

```text
:shelltab
:vterminal
:vbrowser <url>
```

Use different ports for separate development servers, for example the app on 3000 and a separate viewer checkout on 4173. To select a running service, open `:vbrowser` without a URL. Two file previews in the project share a preview origin; server previews have separate origins, so the bridge pairs them explicitly.
