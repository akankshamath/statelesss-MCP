import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const app = new Hono()

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY

if (!OPENWEATHER_API_KEY) {
  throw new Error('OPENWEATHER_API_KEY environment variable is required')
}

interface WeatherData {
  weather: Array<{ description: string }>
  main: {
    temp: number
    humidity: number
  }
  wind: {
    speed: number
  }
}

const weatherToolSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
  longitude: z.number().min(-180).max(180).describe('Longitude coordinate')
})

type WeatherToolInput = z.infer<typeof weatherToolSchema>

const server = new Server(
  {
    name: 'weather-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a location using coordinates',
        inputSchema: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Latitude coordinate'
            },
            longitude: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Longitude coordinate'
            }
          },
          required: ['latitude', 'longitude']
        }
      }
    ]
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name !== 'get_weather') {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
  }

  try {
    const { latitude, longitude } = weatherToolSchema.parse(args)

    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${latitude}&lon=${longitude}&exclude=minutely,hourly,daily,alerts&appid=${OPENWEATHER_API_KEY}&units=metric`

    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Weather API returned ${response.status}: ${response.statusText}`)
    }

    interface OneCallData {
      current: {
        temp: number
        humidity: number
        wind_speed: number
        weather: { description: string }[]
      }
    }
    
    const data = await response.json() as OneCallData

        
    const weather = {
      description: data.current.weather[0]?.description || 'Unknown',
      temperature: Math.round(data.current.temp * 10) / 10,
      humidity: data.current.humidity,
      windSpeed: Math.round(data.current.wind_speed * 10) / 10, // wind_speed for onecall
      location: `${latitude}, ${longitude}`
    }

    return {
      content: [
        {
          type: 'text',
          text: `Weather at coordinates ${weather.location}:
• Conditions: ${weather.description}
• Temperature: ${weather.temperature}°C
• Humidity: ${weather.humidity}%
• Wind Speed: ${weather.windSpeed} m/s`
        }
      ]
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.message}`)
    }

    console.error('Weather API Error:', error)
    throw new McpError(
      ErrorCode.InternalError,
      `Error fetching weather data: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
    )
  }
})


app.post('/mcp', async (c) => {
  try {
    const body = await c.req.text()
    
    if (!body) {
      return c.json({ error: 'No request body' }, 400)
    }

    const lines = body.split('\n').filter(line => line.trim())
    const responses: string[] = []

    for (const line of lines) {
      try {
        const request = JSON.parse(line)
        
        let response
        if (request.method === 'tools/list') {
          response = await server.request(
            { method: 'tools/list', params: {} },
            ListToolsRequestSchema
          )
        } else if (request.method === 'tools/call') {
          response = await server.request(request, CallToolRequestSchema)
        } else {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' }
          }
        }

        const responseData = {
          jsonrpc: '2.0',
          id: request.id,
          result: response
        }
        
        responses.push(JSON.stringify(responseData))
      } catch (parseError) {
        console.error('Parse error:', parseError)
        const errorResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' }
        }
        responses.push(JSON.stringify(errorResponse))
      }
    }

    return new Response(responses.join('\n'), {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    })
  } catch (error) {
    console.error('Request processing error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'mcp-weather-server',
    version: '1.0.0',
    hasApiKey: !!OPENWEATHER_API_KEY
  })
})

// Testing - SF coordinates 
app.get('/test-weather', async (c) => {
  const lat = c.req.query('lat') || '37.7749' 
  const lon = c.req.query('lon') || '-122.4194'
  
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric`
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error(`Weather API returned ${response.status}`)
    }
    
    const data = await response.json() as WeatherData
    
    return c.json({
      success: true,
      location: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
      weather: {
        description: data.weather[0]?.description,
        temperature: data.main.temp,
        humidity: data.main.humidity,
        windSpeed: data.wind.speed
      }
    })
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
})

app.options('*', (c) => c.text('OK', 200))

export const handler = handle(app)