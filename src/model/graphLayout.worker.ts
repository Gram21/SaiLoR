// [impl->req~ui-210~1]
import { layoutHost, type LayoutMessage } from './graphLayout'

const handle = layoutHost((frame, transfer) => self.postMessage(frame, { transfer }))
self.onmessage = (e: MessageEvent<LayoutMessage>) => handle(e.data)
