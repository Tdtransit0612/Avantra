'use client'

import { useRef, useEffect } from 'react'
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps'
import { Input } from '@/components/ui/input'
import { MapPin } from 'lucide-react'

export interface ParsedAddress {
  address: string
  city: string
  state: string
  zip: string
}

interface Props {
  value: string
  onChange: (v: string) => void
  onPlaceSelect: (p: ParsedAddress) => void
  className?: string
  placeholder?: string
  /** Optional extra classes for the input element itself (when rendered in compact forms) */
  inputClassName?: string
}

function PlacesAutocompleteInner({
  value, onChange, onPlaceSelect, className, placeholder, inputClassName,
}: Props) {
  const inputRef    = useRef<HTMLInputElement>(null)
  const onChangeRef = useRef(onChange)
  const onSelectRef = useRef(onPlaceSelect)
  const placesLib   = useMapsLibrary('places')

  // Keep refs current without re-triggering the autocomplete effect
  useEffect(() => { onChangeRef.current = onChange },    [onChange])
  useEffect(() => { onSelectRef.current = onPlaceSelect }, [onPlaceSelect])

  // Create Autocomplete once when the places library is ready
  useEffect(() => {
    if (!placesLib || !inputRef.current) return
    const ac = new placesLib.Autocomplete(inputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['address_components', 'formatted_address'],
    })
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace()
      if (!place.address_components) return
      let streetNumber = '', route = '', city = '', state = '', zip = ''
      for (const comp of place.address_components) {
        const t = comp.types[0]
        if (t === 'street_number')              streetNumber = comp.long_name
        else if (t === 'route')                 route        = comp.long_name
        else if (t === 'locality' || t === 'sublocality_level_1') city = comp.long_name
        else if (t === 'administrative_area_level_1') state  = comp.short_name
        else if (t === 'postal_code')           zip          = comp.long_name
      }
      const address = [streetNumber, route].filter(Boolean).join(' ')
      onChangeRef.current(address)
      onSelectRef.current({ address, city, state, zip })
    })
    return () => { window.google?.maps?.event?.removeListener(listener) }
  }, [placesLib]) // runs only once when library loads — callbacks come from refs

  return (
    <div className={`relative ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? 'Start typing an address…'}
        className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-white/5 dark:border-white/10 dark:text-white pr-8 ${inputClassName ?? ''}`}
      />
      <MapPin className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
    </div>
  )
}

const GMAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ''

export function AddressAutocompleteInput(props: Props) {
  if (!GMAPS_KEY) {
    return (
      <div className={`relative ${props.className ?? ''}`}>
        <Input
          value={props.value}
          onChange={e => props.onChange(e.target.value)}
          placeholder={props.placeholder ?? 'Street address'}
          className={props.inputClassName}
        />
      </div>
    )
  }
  return (
    <APIProvider apiKey={GMAPS_KEY} libraries={['places']}>
      <PlacesAutocompleteInner {...props} />
    </APIProvider>
  )
}

export default AddressAutocompleteInput
