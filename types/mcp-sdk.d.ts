declare module '@modelcontextprotocol/sdk' {
    export class StreamingHttpTransport {
      constructor(options: { request: Request });
      acceptStream(): Promise<{
        inputStream: ReadableStream<Uint8Array>,
        respondStream: WritableStream<Uint8Array>
      }>
    }
  }
  