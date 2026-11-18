/* tslint:disable */
/* eslint-disable */

export function check_spec(spec_source: string, constants_json: string): string;

export function check_spec_with_cfg(spec_source: string, cfg_source: string, constants_json: string, max_states: number, max_depth: number, allow_deadlock: boolean, export_dot: boolean): string;

export function check_spec_with_config(spec_source: string, constants_json: string, max_states: number, max_depth: number, allow_deadlock: boolean, export_dot: boolean): string;

/**
 * Check browser-selected modules through the native resolver without I/O.
 */
export function check_spec_with_modules(root_module: string, sources_json: string, options_json: string): string;

export function check_spec_with_options(spec_source: string, options_json: string): string;

export function explore_eval(spec_source: string, cfg_source: string, constants_json: string, state_json: string, expr_source: string): string;

export function explore_init(spec_source: string, cfg_source: string, constants_json: string): string;

/**
 * Generate all configured Init choices from the selected modules in memory.
 */
export function explore_init_with_modules(root_module: string, sources_json: string, options_json: string): string;

export function explore_invariants(spec_source: string, cfg_source: string, constants_json: string, state_json: string): string;

export function explore_next(spec_source: string, cfg_source: string, constants_json: string, state_json: string): string;

/**
 * Generate concrete Next choices for a lossless opaque state token.
 */
export function explore_next_with_modules(root_module: string, sources_json: string, options_json: string, state_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly check_spec: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly check_spec_with_cfg: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly check_spec_with_config: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly check_spec_with_modules: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly check_spec_with_options: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly explore_eval: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly explore_init: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly explore_init_with_modules: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly explore_invariants: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly explore_next: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly explore_next_with_modules: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
