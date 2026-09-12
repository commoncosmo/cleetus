// Text imports (`import x from "./f.md" with { type: "text" }`). Bun resolves these at
// build time and embeds the file contents into the compiled binary; this declaration
// lets `tsc --noEmit` type the import as a string.
declare module "*.md" {
  const content: string;
  export default content;
}
