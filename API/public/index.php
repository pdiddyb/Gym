<?php

declare(strict_types=1);

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($method === 'GET' && $path === '/health') {
    http_response_code(200);
    echo json_encode(['status' => 'ok']);
    exit;
}

if ($method === 'POST' && $path === '/api/auth/google') {
    $input = json_decode((string) file_get_contents('php://input'), true);

    if (!is_array($input) || empty($input['id_token']) || empty($input['screen_name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'id_token and screen_name are required']);
        exit;
    }

    $googleData = verifyGoogleToken((string) $input['id_token']);
    if ($googleData === null) {
        http_response_code(401);
        echo json_encode(['error' => 'Invalid Google token']);
        exit;
    }

    $email = $googleData['email'] ?? null;
    $firstName = $googleData['given_name'] ?? '';
    $lastName = $googleData['family_name'] ?? '';

    if (!is_string($email) || $email === '') {
        http_response_code(401);
        echo json_encode(['error' => 'Token is missing email claim']);
        exit;
    }

    $pdo = createPdo();
    $stmt = $pdo->prepare(
        'INSERT INTO users (email, first_name, last_name, screen_name)
         VALUES (:email, :first_name, :last_name, :screen_name)
         ON DUPLICATE KEY UPDATE
            first_name = VALUES(first_name),
            last_name = VALUES(last_name),
            screen_name = VALUES(screen_name)'
    );
    $stmt->execute([
        ':email' => $email,
        ':first_name' => (string) $firstName,
        ':last_name' => (string) $lastName,
        ':screen_name' => (string) $input['screen_name'],
    ]);
    $operation = $stmt->rowCount() === 1 ? 'created' : 'updated';

    http_response_code($operation === 'created' ? 201 : 200);
    echo json_encode([
        'operation' => $operation,
        'email' => $email,
        'first_name' => (string) $firstName,
        'last_name' => (string) $lastName,
        'screen_name' => (string) $input['screen_name'],
    ]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'Not found']);

function verifyGoogleToken(string $idToken): ?array
{
    $expectedAudience = getenv('GOOGLE_CLIENT_ID') ?: '';
    if ($expectedAudience === '') {
        return null;
    }

    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode($idToken);
    $context = stream_context_create(
        [
            'http' => [
                'method' => 'GET',
                'timeout' => 10,
            ],
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ]
    );

    set_error_handler(static function (): bool {
        return true;
    });
    try {
        $response = file_get_contents($url, false, $context);
    } finally {
        restore_error_handler();
    }

    if ($response === false) {
        return null;
    }

    $decoded = json_decode($response, true);
    if (!is_array($decoded) || !empty($decoded['error_description'])) {
        return null;
    }

    $audience = $decoded['aud'] ?? null;
    $issuer = $decoded['iss'] ?? null;
    $expiration = $decoded['exp'] ?? null;

    if (!is_string($audience) || !hash_equals($expectedAudience, $audience)) {
        return null;
    }

    if (!is_string($issuer) || !in_array($issuer, ['accounts.google.com', 'https://accounts.google.com'], true)) {
        return null;
    }

    if (!is_scalar($expiration) || (int) $expiration <= time()) {
        return null;
    }

    return $decoded;
}

function createPdo(): PDO
{
    $host = getenv('DB_HOST') ?: '127.0.0.1';
    $port = getenv('DB_PORT') ?: '3306';
    $db = getenv('DB_NAME') ?: 'gym';
    $user = getenv('DB_USER') ?: 'root';
    $pass = getenv('DB_PASSWORD') ?: '';

    return new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $host, $port, $db),
        $user,
        $pass,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );
}
