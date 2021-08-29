import './styles.css'

import { useEffect, useState } from 'preact/hooks'
import {
  distanceBetweenCoordinates,
  LatLong,
} from './distance-between-coordinates'

const purpleairApiKey = import.meta.env.VITE_PURPLEAIR_READ_KEY
if (!purpleairApiKey) throw new Error('missing API key VITE_PURPLEAIR_READ_KEY')
const mapquestApiKey = import.meta.env.VITE_MAPQUEST_KEY
if (!mapquestApiKey) throw new Error('missing API key VITE_MAPQUEST_KEY')

const margin = 1
// 10 km
const distanceThresholdMeters = 10000

const selectedField = 'pm2.5_10minute'

const fields = [
  'name',
  'sensor_index',
  'latitude',
  'longitude',
  'confidence',
  'humidity',
  'pm2.5_cf_1',
  selectedField,
] as const

const fieldsStr = fields.join(',')

type FieldName = typeof fields[number]

type FieldEntry = Record<FieldName, string | number>

const localStorageKey = 'cachedLocation'

interface Position {
  name?: string
  coords: LatLong
}

const getCachedPosition = () => {
  const cachedPosition = localStorage.getItem(localStorageKey)
  if (cachedPosition)
    try {
      const parsed: Position = JSON.parse(cachedPosition)
      return parsed
    } catch {}
  return null
}

export const App = () => {
  const [position, setPosition] = useState<Position | null>(getCachedPosition)
  const coords = position?.coords
  const locationName = position?.name

  useEffect(() => {
    ;(async () => {
      const permission = await navigator.permissions.query({
        name: 'geolocation',
      })
      if (permission.state === 'granted') {
        const location = await new Promise<GeolocationPosition>(
          (resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject),
        )
        const newPos: Position = {
          coords: {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          },
        }
        setPosition((oldPos) => {
          const isChanged =
            newPos.coords.latitude !== oldPos?.coords.latitude ||
            newPos.coords.longitude !== oldPos?.coords.longitude
          if (isChanged) {
            localStorage.setItem(localStorageKey, JSON.stringify(newPos))
            return newPos
          }
          return oldPos
        })
      }
    })().catch(() => {})
  }, [])
  const [data, setData] = useState<FieldEntry[] | null>(null)

  useEffect(() => {
    if (!coords) return
    const { latitude, longitude } = coords
    const params = {
      fields: fieldsStr,
      nwlng: longitude - margin,
      nwlat: latitude + margin,
      selng: longitude + margin,
      selat: latitude - margin,
      max_age: 20 * 60, // 20 minutes -> seconds
    } as any as Record<string, string>
    fetch(
      `https://api.purpleair.com/v1/sensors?${new URLSearchParams(params)}`,
      {
        headers: { 'X-API-Key': String(purpleairApiKey) },
      },
    ).then(async (res) => {
      const data = await res.json()
      const output: FieldEntry[] = []
      for (const entry of data.data) {
        const entryObj: Record<FieldName, string | number> = {} as any
        for (let i = 0; i < data.fields.length; i++) {
          entryObj[data.fields[i] as FieldName] = entry[i]
        }
        output.push(entryObj)
      }
      const dataWithinRange = output.filter((point) => {
        return (
          point.confidence > 70 &&
          distanceBetweenCoordinates(point as any, coords) <
            distanceThresholdMeters
        )
      })
      setData(dataWithinRange)
    })
  }, [coords])

  useEffect(() => {
    if (!coords || locationName) return
    const { latitude, longitude } = coords
    fetch(
      `https://www.mapquestapi.com/geocoding/v1/reverse?key=${mapquestApiKey}&location=${latitude},${longitude}&includeNearestIntersection=true`,
    ).then(async (res) => {
      const data = await res.json()
      const location = data?.results?.[0]?.locations?.[0]
      const nearestIntersection = location?.nearestIntersection
      let locationName =
        (nearestIntersection?.distanceMeters < 500 &&
          nearestIntersection?.label) ||
        location?.street
      if (location?.adminArea5) locationName += ` - ${location.adminArea5}`

      setPosition((oldPos) => {
        if (oldPos?.coords === coords) {
          const newPos: Position = { ...oldPos, name: locationName }
          localStorage.setItem(localStorageKey, JSON.stringify(newPos))
          return newPos
        }
        return oldPos
      })
    })
  }, [coords, locationName])

  return (
    <>
      {!coords && <h1>No GPS location</h1>}
      {!coords || !data ? (
        <h1>Loading</h1>
      ) : data.length < 1 ? (
        <h1>{`No data found within ${distanceThresholdMeters / 1000} km`}</h1>
      ) : (
        <>
          {locationName && <h2>{locationName}</h2>}
          <h1>
            {Math.round(
              AQIPM25(
                distanceWeightedAverage(
                  data.map((entry) => ({
                    latitude: entry.latitude as number,
                    longitude: entry.longitude as number,
                    value: epaCompensate(entry),
                  })),
                  coords,
                ),
              ) || NaN,
            )}
          </h1>
        </>
      )}
    </>
  )
}

const distanceWeightedAverage = (
  data: (LatLong & { value: number })[],
  userPosition: LatLong,
) => {
  let dataSum = 0
  let weightsSum = 0
  for (const entry of data) {
    if (entry.value !== undefined) {
      let distance = distanceBetweenCoordinates(userPosition, entry)
      // Prevent "infinite weight"
      if (distance === 0) distance = 1
      const weight = 1 / distance ** 2
      weightsSum += weight
      dataSum += weight * Number(entry.value)
    }
  }
  return dataSum / weightsSum
}

const average = (data: FieldEntry[], field: FieldName) => {
  let sum = 0
  let count = 0
  for (const entry of data) {
    const stat = entry[field]
    if (stat !== undefined) {
      sum += Number(stat)
      count++
    }
  }
  return sum / count
}

const lerp = (
  outputMax: number,
  outputMin: number,
  inputMax: number,
  inputMin: number,
  val: number,
) =>
  ((val - inputMin) / (inputMax - inputMin)) * (outputMax - outputMin) +
  outputMin

const AQIPM25 = (ppm: number) => {
  if (ppm < 12.1) return lerp(50, 0, 12, 0, ppm)
  if (ppm < 35.5) return lerp(100, 51, 35.4, 12.1, ppm)
  if (ppm < 55.5) return lerp(150, 101, 55.4, 35.5, ppm)
  if (ppm < 150.5) return lerp(200, 151, 150.4, 55.5, ppm)
  if (ppm < 250.5) return lerp(300, 201, 250.4, 150.5, ppm)
  if (ppm < 350.5) return lerp(400, 301, 350.4, 250.5, ppm)
  if (ppm < 500.5) return lerp(500, 401, 500.4, 350.5, ppm)
}

// compensate
const convert = function (pm: number, humidity = 35) {
  var compensated = 0.534 * pm - 0.0844 * humidity + 5.604
  if (compensated < 0) return 0
  return compensated
}

const epaCompensate = (t: FieldEntry) => {
  return convert(t['pm2.5_cf_1'] as number, t.humidity as number)
}
