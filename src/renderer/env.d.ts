declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}

declare module 'write-file-atomic' {
  interface Options {
    encoding?: BufferEncoding
    fsync?: boolean
  }
  export default function writeFileAtomic(path: string, data: string | Buffer | Uint8Array, options?: Options): Promise<void>
}
