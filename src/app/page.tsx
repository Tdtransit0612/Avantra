import { redirect } from 'next/navigation'

// Root: the middleware sends unauthenticated visitors to /login and authenticated
// ones onward; land everyone on the dashboard as the canonical entry point.
export default function Home() {
  redirect('/dashboard')
}
