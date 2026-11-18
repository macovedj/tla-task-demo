# TLA+ task demo

A small task app with explicit links between TLA+ actions and application
functions. It has three states (`absent`, `open`, `done`) and five directed
transitions. The browser runs the real app functions; `observe()` reads their
current state, and the UI mirrors that state.

## Run

Use Node.js 20 or newer. There are no npm dependencies.

```sh
npm run dev
```

Open `http://localhost:3000/lab.html` for the linked app and viewer, or
`http://localhost:3000` for the app alone. Run the checks with `npm test`.

In edit-test.dev, import this repository and open **`lab.html` as a shared
file preview**. Both panes then share the project's isolated preview origin.
Use file preview for this prototype: the private listening-port preview's
single-document authorization can reject nested frames. A local `file://`
URL can also block JavaScript modules.

The lab loads `tla-bindings.json`, the model, and the bound application source
files, then connects the bundled viewer to the real app in the adjacent pane.
The viewer's source buttons open a read-only source view inside that pane.
They work without an Edit project URL and keep the app connection alive.

An optional **Edit project URL** supplies a secondary editor deep link. Paste
the editor's project URL, including its `?file=…` path, then choose **Reload
connection**. Opening another Edit session may require taking ownership of
the workspace. Reloading the connection reloads both panes and starts a new
channel session.

## Try it

- **Add** creates the task, **Complete** marks it done, **Reopen** opens it
  again, and **Delete** removes it. Only actions enabled in the current state
  are valid.
- **Reset** returns the task to `absent`.
- Enable the **Break Complete** toggle to make Complete leave the task `open`.
  A model-driven check should report the expected `done` versus observed
  `open`. The toggle survives reset and is deliberately outside the model.
- Use the linked viewer to choose enabled model actions and compare the
  expected successor with the app's observed result. To take another branch,
  restore the app by resetting and replaying the desired prefix. The viewer
  performs this explicitly; selecting a model state alone cannot rewind an app.

The preview's browser console exposes the same adapter:

```js
window.tlaTaskDemo.reset();
window.tlaTaskDemo.perform("Add");
window.tlaTaskDemo.perform("Complete");
window.tlaTaskDemo.observe(); // { status: "done" } when the fault is off
```

## Model and source links

In TLA+ State Explorer, choose **Open specification**, select both
`model/Task.tla` and `model/Task.cfg`, then analyze or start an interactive
trace. The finite model has three states and five transitions. `TypeOK`
checks the status domain; detecting the injected fault requires comparing
each observed result with its expected model successor.

`tla-bindings.json` proposes a portable version-1 contract: model paths,
action IDs mapped to source functions, observation/reset functions, and the
adapter entry point. For example, `Complete` maps to
`src/task-app.js#completeTask`.

The bundled linked viewer implements this experimental contract. It is not
an Edit extension or a general import format in the standalone explorer.
The lab transfers a dedicated MessageChannel between verified same-origin
frames. Only registered actions and matching source bindings may execute;
each operation independently reads `observe()` afterward. Reloading either
frame retires its old session and discards queued operations.

The adapter runs inside the visible app instance. No app module is imported
into the model worker, and no application code is evaluated from the manifest.
The bridge does not relax Edit's preview sandbox, CSP, or COOP. Selected trace
comparisons do not establish exhaustive implementation correctness.
