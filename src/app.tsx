import './styles.css'

import { useEffect, useState } from 'preact/hooks'
import {
  distanceBetweenCoordinates,
  LatLong,
} from './distance-between-coordinates'

const apiKey = import.meta.env.VITE_PURPLEAIR_READ_KEY
if (!apiKey) throw new Error('missing API key VITE_PURPLEAIR_READ_KEY')

const useGeolocation = () => {
  const [position, setPosition] = useState<GeolocationPosition | null>(null)
  useEffect(() => {
    new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject)
    }).then(setPosition)
  }, [])
  return position
}

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

export const App = () => {
  const userPosition = useGeolocation()
  const [data, setData] = useState<FieldEntry[] | null>(null)

  useEffect(() => {
    if (!userPosition) return
    const { latitude, longitude } = userPosition.coords
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
        headers: { 'X-API-Key': String(apiKey) },
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
          distanceBetweenCoordinates(point as any, userPosition.coords) <
            distanceThresholdMeters
        )
      })
      setData(dataWithinRange)
    })
  }, [userPosition, margin, distanceThresholdMeters])

  return (
    <>
      {!userPosition && <h1>No GPS location</h1>}
      {!userPosition || !data ? (
        <h1>Loading</h1>
      ) : data.length < 1 ? (
        <h1>{`No data found within ${distanceThresholdMeters / 1000} km`}</h1>
      ) : (
        <>
          <h1>
            {Math.round(
              AQIPM25(
                distanceWeightedAverage(
                  data.map((entry) => ({
                    latitude: entry.latitude as number,
                    longitude: entry.longitude as number,
                    value: epaCompensate(entry),
                  })),
                  userPosition.coords,
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
