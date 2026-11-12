#!/usr/bin/env ruby

require 'json'
require 'net/http'
require 'uri'
require 'webrick'

ROOT = File.expand_path(__dir__)
PORT = Integer(ENV.fetch('PORT', '4173'))
HOST = ENV.fetch('HOST', '127.0.0.1')
NOMINATIM_BASE = ENV.fetch('NOMINATIM_URL', 'https://nominatim.openstreetmap.org').sub(%r{/+$}, '')
VALHALLA_URL = ENV.fetch('VALHALLA_URL', 'https://valhalla1.openstreetmap.de/route')
GEOCODE_CACHE = {}
GEOCODE_LOCK = Mutex.new
@last_geocode_at = 0.0

def json_response(response, status, value)
  response.status = status
  response['Content-Type'] = 'application/json; charset=utf-8'
  response['Cache-Control'] = 'no-store'
  response['X-Content-Type-Options'] = 'nosniff'
  response.body = JSON.generate(value)
end

def request_json(uri, body = nil, headers = {})
  uri = URI(uri) unless uri.is_a?(URI)
  request = body ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
  headers.each { |key, value| request[key] = value }
  request.body = JSON.generate(body) if body
  Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: 12, read_timeout: 25) do |http|
    http.request(request)
  end
end

def geocode(query)
  normalized = query.to_s.strip.gsub(/\s+/, ' ').downcase
  raise ArgumentError, 'Bitte mindestens zwei Zeichen eingeben.' if normalized.length < 2
  raise ArgumentError, 'Die Suche ist zu lang.' if normalized.length > 180
  return GEOCODE_CACHE[normalized] if GEOCODE_CACHE.key?(normalized)

  GEOCODE_LOCK.synchronize do
    return GEOCODE_CACHE[normalized] if GEOCODE_CACHE.key?(normalized)
    wait = 1.1 - (Process.clock_gettime(Process::CLOCK_MONOTONIC) - @last_geocode_at)
    sleep(wait) if wait.positive?
    @last_geocode_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    uri = URI("#{NOMINATIM_BASE}/search")
    uri.query = URI.encode_www_form(q: query.to_s.strip, format: 'jsonv2', addressdetails: '1', limit: '5')
    upstream = request_json(uri, nil, {
      'Accept' => 'application/json',
      'Accept-Language' => 'de,en;q=0.8',
      'User-Agent' => 'MopedautoRoutePlanner/1.0 (local OpenStreetMap routing demo)'
    })
    raise "Adresssuche antwortet mit Status #{upstream.code}." unless upstream.is_a?(Net::HTTPSuccess)

    places = JSON.parse(upstream.body)
    results = places.map do |place|
      label = place['display_name'].to_s
      {
        lat: place['lat'].to_f,
        lon: place['lon'].to_f,
        name: place['name'].to_s.empty? ? label.split(',').first : place['name'],
        label: label,
        type: place['type']
      }
    end
    GEOCODE_CACHE[normalized] = results
    GEOCODE_CACHE.shift if GEOCODE_CACHE.length > 250
    results
  end
end

def valid_point?(point)
  return false unless point.is_a?(Hash)
  lat = Float(point['lat'])
  lon = Float(point['lon'])
  lat.abs <= 90 && lon.abs <= 180
rescue ArgumentError, TypeError
  false
end

def calculate_route(body)
  raise ArgumentError, 'Start und Ziel benötigen gültige Koordinaten.' unless valid_point?(body['start']) && valid_point?(body['destination'])

  speed = [[Float(body['topSpeed'] || 45), 30].max, 80].min
  request = {
    locations: [
      { lat: Float(body['start']['lat']), lon: Float(body['start']['lon']), type: 'break' },
      { lat: Float(body['destination']['lat']), lon: Float(body['destination']['lon']), type: 'break' }
    ],
    costing: 'auto',
    costing_options: {
      auto: {
        top_speed: speed,
        use_highways: body['avoidHighways'] == false ? 0.5 : 0,
        use_tolls: 0,
        use_ferry: 0
      }
    },
    units: 'kilometers',
    language: 'de-DE',
    format: 'json',
    directions_type: 'instructions'
  }
  upstream = request_json(VALHALLA_URL, request, {
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
    'X-Client-Id' => 'mopedauto-routeplaner-local-demo'
  })
  data = JSON.parse(upstream.body) rescue {}
  unless upstream.is_a?(Net::HTTPSuccess)
    message = data['error'] || data['message'] || "Routing antwortet mit Status #{upstream.code}."
    raise message
  end
  data.merge(routeSettings: { topSpeed: speed, avoidHighways: body['avoidHighways'] != false })
end

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: HOST,
  DocumentRoot: ROOT,
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN)
)

server.mount_proc('/api/geocode') do |request, response|
  begin
    json_response(response, 200, { results: geocode(request.query['q']) })
  rescue ArgumentError => error
    json_response(response, 400, { error: error.message })
  rescue StandardError => error
    json_response(response, 502, { error: error.message.empty? ? 'Adresssuche fehlgeschlagen.' : error.message })
  end
end

server.mount_proc('/api/route') do |request, response|
  begin
    raise ArgumentError, 'Anfrage ist zu groß.' if request.body.to_s.bytesize > 16_384
    body = JSON.parse(request.body.to_s)
    json_response(response, 200, calculate_route(body))
  rescue JSON::ParserError
    json_response(response, 400, { error: 'Ungültige JSON-Anfrage.' })
  rescue ArgumentError => error
    json_response(response, 400, { error: error.message })
  rescue StandardError => error
    json_response(response, 502, { error: error.message.empty? ? 'Routing fehlgeschlagen.' : error.message })
  end
end

trap('INT') { server.shutdown }
trap('TERM') { server.shutdown }
puts "Mopedauto-Routenplaner läuft auf http://#{HOST}:#{PORT}"
server.start
