# BNS V2 API Endpoints

Base URL: `https://api.bnsv2.com`

For all testnet calls preppend to the endpoint /testnet
Ex. 
```http
GET /names
GET /testnet/names
```


### 1. List All Names

```http
GET /names
```

Lists all BNS names regardless of status.

### 2. List Valid Names

```http
GET /names/valid
```

Lists only valid (not expired/revoked) names.

### 3. List Expired Names

```http
GET /names/expired
```

Lists expired names.

### 4. List Revoked Names

```http
GET /names/revoked
```

Lists revoked names.

### 5. List Valid Names for Address

```http
GET /names/address/{address}/valid
```

Returns valid names owned by address.

### 6. List Expired Names for Address

```http
GET /names/address/{address}/expired
```

Returns expired names owned by address.

### 7. List Names About to Expire for Address

```http
GET /names/address/{address}/expiring-soon
```

Returns names expiring within 4320 blocks.

### 8. List Revoked Names for Address

```http
GET /names/address/{address}/revoked
```

Returns revoked names owned by address.

### 9. Get Name Details

```http
GET /names/{full_name}
```

Returns detailed information about a name.

### 10. List All Namespaces

```http
GET /namespaces
```

Returns information about all namespaces.

### 11. List Names in Namespace

```http
GET /names/namespace/{namespace}
```

Returns all names in a specific namespace.

### 12. Resolve Name

```http
GET /resolve-name/{full_name}
```

Returns zonefile if available.

### 13. Get Namespace Details

```http
GET /namespaces/{namespace}
```

Returns detailed namespace information.

### 14. Check Name Registration Availability

```http
GET /names/{namespace}/{name}/can-register
```

Checks if a name can be registered.

### 15. Get Last Token ID

```http
GET /token/last-id
```

Returns the last minted token ID.

### 16. Get Name Renewal Status

```http
GET /names/{full_name}/renewal
```

Returns renewal information for a name.

### 17. Check Name Resolution Status

```http
GET /names/{full_name}/can-resolve
```

Checks if a name can be resolved.

### 18. Get Name Owner

```http
GET /names/{full_name}/owner
```

Returns current owner of a name.

### 19. Get Token Owner

```http
GET /tokens/{id}/owner
```

Returns owner of a specific token ID.

### 20. Get Token ID from Name

```http
GET /names/{full_name}/id
```

Returns token ID for a specific name.

### 21. Get Name from Token ID

```http
GET /tokens/{id}/name
```

Returns name associated with token ID.

### 22. Get Name Info from Token ID

```http
GET /tokens/{id}/info
```

Returns detailed information about a name by its token ID.

### 23. Get Name Rarity Metrics

```http
GET /names/{full_name}/rarity
```

Returns rarity score and metrics for a name.

### 24. Get Rarest Names in Namespace

```http
GET /namespaces/{namespace}/rare-names
```

Returns the rarest names in a namespace.

## Common Parameters

All list endpoints support:

- `limit` (default: 50)
- `offset` (default: 0)

## Rarity System

The BNS rarity system evaluates names using the following criteria:

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

Lower scores indicate rarer names.
