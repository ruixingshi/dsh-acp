/** ACP SDK server wiring for one client connection. */

import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type Stream,
} from '@agentclientprotocol/sdk'
import { DshAcpAgent, type AcpLogger, type DshAcpAgentOptions } from './acp-agent.js'
import type { HarnessRuntime } from './runtime.js'

/** Single-connection ACP v1 server backed by one Harness runtime. */
export class DshAcpServer {
  /** Registered ACP handlers, also exposed for in-process protocol tests. */
  readonly app: AgentApp

  private connection: AgentConnection | undefined
  private handler: DshAcpAgent | undefined
  private disposal: Promise<void> | undefined

  constructor(
    private readonly runtime: HarnessRuntime,
    private readonly options: DshAcpAgentOptions,
    private readonly logger: AcpLogger = {
      warn: (message) => process.stderr.write(`${message}\n`),
    },
  ) {
    this.app = agent({ name: options.name ?? 'dsh-acp' })
      .onConnect((connection) => this.acceptConnection(connection))
      .onRequest(methods.agent.initialize, ({ params }) => this.requireHandler().initialize(params))
      .onRequest(methods.agent.session.new, ({ params }) =>
        this.requireHandler().newSession(params),
      )
      .onRequest(methods.agent.session.close, ({ params }) =>
        this.requireHandler().closeSession(params),
      )
      .onRequest(methods.agent.session.setConfigOption, ({ params }) =>
        this.requireHandler().setSessionConfigOption(params),
      )
      .onRequest(methods.agent.session.prompt, ({ params, signal }) =>
        this.promptWithCancellation(params, signal),
      )
      .onNotification(methods.agent.session.cancel, ({ params }) =>
        this.requireHandler().cancel(params),
      )
  }

  /** Serve one ACP client over a bidirectional transport. */
  connect(stream: Stream): AgentConnection {
    return this.app.connect(stream)
  }

  /** Close the transport and release every runtime resource exactly once. */
  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeOnce())
  }

  private acceptConnection(connection: AgentConnection): void {
    if (this.connection !== undefined) {
      connection.close(RequestError.internalError(undefined, 'ACP server already has a client'))
      return
    }
    if (this.disposal !== undefined) {
      connection.close(RequestError.internalError(undefined, 'ACP server is closed'))
      return
    }

    this.connection = connection
    const handler = new DshAcpAgent(
      this.runtime,
      {
        sessionUpdate: (params) => connection.client.notify(methods.client.session.update, params),
        requestPermission: (params, signal) =>
          connection.client.request(methods.client.session.requestPermission, params, {
            ...(signal === undefined ? {} : { cancellationSignal: signal }),
          }),
      },
      this.options,
      this.logger,
    )
    this.handler = handler
    void connection.closed
      .then(() => handler.dispose())
      .catch((error: unknown) => {
        this.logger.warn(`dsh-acp: connection teardown failed: ${String(error)}`)
      })
  }

  private async promptWithCancellation(
    params: Parameters<DshAcpAgent['prompt']>[0],
    signal: AbortSignal,
  ): ReturnType<DshAcpAgent['prompt']> {
    const handler = this.requireHandler()
    let cancellationStarted = false
    const cancel = (): void => {
      if (cancellationStarted) return
      cancellationStarted = true
      void handler.cancel({ sessionId: params.sessionId }).catch((error: unknown) => {
        this.logger.warn(`dsh-acp: prompt request cancellation failed: ${String(error)}`)
      })
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const response = handler.prompt(params)
      if (signal.aborted) cancel()
      return await response
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  private requireHandler(): DshAcpAgent {
    if (this.handler === undefined) {
      throw RequestError.internalError(undefined, 'ACP connection is not ready')
    }
    return this.handler
  }

  private async disposeOnce(): Promise<void> {
    this.connection?.close()
    await this.handler?.dispose()
    if (this.handler === undefined) await this.runtime.dispose()
  }
}
