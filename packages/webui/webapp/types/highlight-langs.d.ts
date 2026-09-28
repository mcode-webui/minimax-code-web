// webapp/lib/code-highlight.d.ts
//
// Ambient declarations for the hljs language module imports. Each
// `highlight.js/lib/languages/<name>.js` module exports a CommonJS
// function (`module.exports = function(hljs){...}`); TypeScript has
// no built-in declaration for these and we don't want to pull in
// `@types/highlight.js` just to satisfy the dynamic-import type.
// This file declares each language module with the shape we use:
//   default export: (hljs: HLJSApi) => Language
// or, if the module exports the function directly, the same.

declare module "highlight.js/lib/core" {
  const hljs: import("highlight.js").default;
  export default hljs;
  export = hljs;
}

declare module "highlight.js/lib/languages/typescript.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/javascript.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/xml.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/json.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/css.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/scss.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/less.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/markdown.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/python.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/ruby.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/go.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/rust.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/java.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/kotlin.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/swift.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/c.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/cpp.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/bash.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/yaml.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/sql.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}

declare module "highlight.js/lib/languages/dockerfile.js" {
  const lang: import("highlight.js").LanguageFn;
  export default lang;
}