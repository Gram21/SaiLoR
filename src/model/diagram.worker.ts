// [impl->req~ui-310~1]
import { diagramHost, type DiagramRequest } from './diagram'

const handle = diagramHost((reply) => self.postMessage(reply))
self.onmessage = (e: MessageEvent<DiagramRequest>) => handle(e.data)
