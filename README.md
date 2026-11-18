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

Open `http://localhost:3000`. Run the checks with `npm test`.

In edit-test.dev, import this repository, then either open `index.html` as a
file preview or run `npm run dev` and open the listening-port preview for
port 3000. File preview still needs an HTTP origin; opening a local `file://`
URL can block JavaScript modules.

## Try it

- **Add** creates the task, **Complete** marks it done, **Reopen** opens it
  again, and **Delete** removes it. Only actions enabled in the current state
  are valid.
- **Reset** returns the task to `absent`.
- Enable the **Break Complete** toggle to make Complete leave the task `open`.
  A model-driven check should report the expected `done` versus observed
  `open`. The toggle survives reset and is deliberately outside the model.
- To take another branch, reset the app and replay the desired action prefix.
  Selecting a previous model state alone does not rewind the running app.

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

This manifest is not yet a supported import format in State Explorer or
Edit. The cross-app bridge is future work. A runner must call the adapter
inside the existing preview instance, then compare `observe()` with the
chosen model successor. Importing a fresh copy into a runner worker would
exercise a separate application instance.
