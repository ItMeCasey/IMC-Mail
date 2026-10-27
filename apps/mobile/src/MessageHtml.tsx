import { Linking } from 'react-native'
import { WebView } from 'react-native-webview'

/**
 * A message page in a locked-down web view. The page (see `buildPhoneDocument`) is sanitized and carries a security
 * policy that allows no scripts or remote loads (web images only when allowed), JavaScript is off in the view, and no
 * link can open inside it: a tap on a web link hands it to the browser, and everything else is refused.
 */
export default function MessageHtml({ doc }: { doc: string }) {
  return (
    <WebView
      style={{ flex: 1, backgroundColor: 'transparent' }}
      originWhitelist={['about:*']}
      source={{ html: doc, baseUrl: 'about:blank' }}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsLinkPreview={false}
      mixedContentMode="never"
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(req) => {
        if (req.url.startsWith('about:')) return true
        if (/^(https?:|mailto:)/i.test(req.url)) void Linking.openURL(req.url)
        return false
      }}
    />
  )
}
