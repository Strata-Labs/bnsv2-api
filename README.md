# BNS V2 API Documentation

## Base URL
`https://api.bnsv2.com`

For testnet, prepend `/testnet` to any endpoint (e.g., `/testnet/names` instead of `/names`).

## Core Endpoints

### Names

1. **List All Names**
```http
GET /names
```

2. **List Valid Names**
```http
GET /names/valid
```

3. **List Expired Names**
```http
GET /names/expired
```

4. **List Revoked Names**
```http
GET /names/revoked
```

### Address-Specific Name Queries

5. **List Valid Names for Address**
```http
GET /names/address/{address}/valid
```

6. **List Expired Names for Address**
```http
GET /names/address/{address}/expired
```

7. **List Names About to Expire for Address**
```http
GET /names/address/{address}/expiring-soon
```
Returns names expiring within 4320 blocks.

8. **List Revoked Names for Address**
```http
GET /names/address/{address}/revoked
```

### Name Operations

9. **Get Name Details**
```http
GET /names/{full_name}
```

10. **List Names in Namespace**
```http
GET /names/namespace/{namespace}
```

11. **Resolve Name**
```http
GET /resolve-name/{full_name}
```

12. **Check Name Registration Availability**
```http
GET /names/{namespace}/{name}/can-register
```

13. **Get Name Renewal Status**
```http
GET /names/{full_name}/renewal
```

14. **Check Name Resolution Status**
```http
GET /names/{full_name}/can-resolve
```

15. **Get Name Owner**
```http
GET /names/{full_name}/owner
```

### Token Operations

16. **Get Last Token ID**
```http
GET /token/last-id
```

17. **Get Token Owner**
```http
GET /tokens/{id}/owner
```

18. **Get Token ID from Name**
```http
GET /names/{full_name}/id
```

19. **Get Name from Token ID**
```http
GET /tokens/{id}/name
```

20. **Get Name Info from Token ID**
```http
GET /tokens/{id}/info
```

### Namespace Operations

21. **List All Namespaces**
```http
GET /namespaces
```

22. **Get Namespace Details**
```http
GET /namespaces/{namespace}
```

### Rarity System

23. **Get Name Rarity Metrics**
```http
GET /names/{full_name}/rarity
```

24. **Get Rarest Names in Namespace**
```http
GET /namespaces/{namespace}/rare-names
```

## Subdomain Endpoints

### Subdomain Operations

1. **Get All Subdomains**
```http
GET /subdomains/{full_name}
```

Response Format:
```json
{
  "subdomains": {
    "sub1": {
      "owner": "SP2ZNGJ85ENDY6QRHQ5P2D4FXQJ6INMT00GBGJ2QX",
      "general": "General profile information",
      "twitter": "@example",
      "url": "https://example.com",
      "nostr": "npub...",
      "lightning": "lightning-address",
      "btc": "bc1..."
    }
  }
}
```

2. **Get Single Subdomain**
```http
GET /subdomain/{full_subdomain}
```

3. **Get Subdomain Owner**
```http
GET /subdomain/{full_subdomain}/owner
```

## BTC Address Resolution

### Get BTC Address
```http
GET /btc-address/{full_name}
```

Response Format:
```json
{
  "btc": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
}
```

Testnet Response:
```json
{
  "network": "testnet",
  "btc": "tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
}
```

## Common Parameters
All list endpoints support:
- `limit` (default: 50)
- `offset` (default: 0)

## Rarity Scoring System

### Scoring Factors

1. **Name Length**
   - 1-3 characters: +10 points (Extremely Rare)
   - 4-5 characters: +30 points (Very Rare)
   - 6-7 characters: +50 points (Moderate)
   - 8-10 characters: +70 points (Common)
   - 11+ characters: +90 points (Very Common)

2. **Character Patterns** (20% weight each)
   - Numeric-only names
   - Letter-only names
   - Special character presence

3. **Special Patterns**
   - Palindromes: -10 points (increases rarity)
   - Repeating characters: +5 points (decreases rarity)

### Rarity Classifications
Final Score (0-100):
- 0-20: Ultra Rare
- 21-40: Rare
- 41-60: Uncommon
- 61-80: Common
- 81-100: Very Common

## Error Responses

Common error responses for all endpoints:

### 404 Not Found
```json
{
  "error": "Name not found, expired or revoked"
}
```

### 400 Bad Request
```json
{
  "error": "Invalid zonefile format"
}
```

## Integration Example

```javascript
async function resolveBtcAddress(bnsName) {
  try {
    const response = await fetch(`https://api.bnsv2.com/btc-address/${bnsName}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to resolve BTC address');
    }
    const data = await response.json();
    return data.btc;
  } catch (error) {
    console.error('Error resolving BTC address:', error);
    throw error;
  }
}

// Usage example
resolveBtcAddress('satoshi.btc')
  .then(btcAddress => console.log('BTC Address:', btcAddress))
  .catch(error => console.error('Error:', error));
```
