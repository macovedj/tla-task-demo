import { addTask, completeTask, reopenTask, deleteTask, observe, reset } from './task-app.js';

// This registry calls the same module instance as the buttons in the preview.
// The model and expected successor states are deliberately absent here.
const handlers = Object.freeze({
  Add: addTask,
  Complete: completeTask,
  Reopen: reopenTask,
  Delete: deleteTask,
});

const sourceBinding = handler => Object.freeze({ file: 'src/task-app.js', function: handler.name });
const bindings = Object.freeze({
  actions: Object.freeze(Object.fromEntries(Object.entries(handlers).map(([action, handler]) => [action, sourceBinding(handler)]))),
  observe: sourceBinding(observe),
  reset: sourceBinding(reset),
});

export function perform(actionId) {
  if (!Object.hasOwn(handlers, actionId)) {
    throw new Error(`Unknown task action: ${String(actionId)}`);
  }
  return handlers[actionId]();
}

export const taskDemo = Object.freeze({
  id: 'tla-task-demo',
  version: 1,
  actions: Object.freeze(Object.keys(handlers)),
  bindings,
  perform,
  observe,
  reset,
});
