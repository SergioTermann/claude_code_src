export type SDKControlRequestInner = Record<string, any>

export type SDKControlRequest = Record<string, any> & {
  type?: 'control_request'
  request_id?: string
  request?: SDKControlRequestInner
}

export type SDKControlPermissionRequest = SDKControlRequest & {
  subtype?: 'permission_request'
  tool_name?: string
  tool_use_id?: string
  input?: Record<string, any>
}

export type SDKControlResponse = Record<string, any> & {
  type?: 'control_response'
  request_id?: string
  response?: Record<string, any>
}

export type SDKControlCancelRequest = Record<string, any> & {
  type?: 'control_cancel_request'
  request_id?: string
}

export type SDKControlInitializeRequest = SDKControlRequest
export type SDKControlInitializeResponse = Record<string, any>
export type SDKControlMcpSetServersResponse = Record<string, any>
export type SDKControlReloadPluginsResponse = Record<string, any> & {
  plugins?: any[]
}

export type StdoutMessage = Record<string, any> & {
  type?: string
  subtype?: string
  uuid?: string
}
