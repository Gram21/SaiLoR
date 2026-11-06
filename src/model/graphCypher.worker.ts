// [impl->req~ui-250~1]
import { cypherHost, type CypherRequest } from './graphCypher'

const handle = cypherHost((reply) => self.postMessage(reply))
self.onmessage = (e: MessageEvent<CypherRequest>) => handle(e.data)
