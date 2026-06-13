export type ConnectorTextBlock = {
  type: 'connector_text'
  text: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  text?: string
}

export function isConnectorTextBlock(value: unknown): value is ConnectorTextBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'connector_text'
  )
}
