import * as React from 'react'
import { Box, Text } from '../../ink.js'

export function WindriseMark(): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="claude">  🌀  </Text>
      <Text color="clawd_body">⌁⌁⌁⌁⌁</Text>
      <Text dimColor>WIND</Text>
    </Box>
  )
}
