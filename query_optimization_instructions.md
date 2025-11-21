# Database Query Optimization Analysis Instructions

## Overview
You are tasked with analyzing a codebase to identify and optimize database queries based on performance insights. This document provides a systematic approach to examine query usage, understand the database architecture, and recommend efficiency improvements.

## Query Insights Data

The following queries have been identified as high-impact based on their execution metrics:

| Query | Read Operations | Executions | Docs Scanned | Index Entries Scanned | Results Returned |
|-------|----------------|------------|--------------|---------------------|------------------|
| COLLECTION /v2_players | 60,089 | 118 | 509.229 | 509.229 | 509.229 |
| COLLECTION /transactions/*/S7 | 34,440 | 56 | 615 | 615 | 615 |
| COLLECTION /v2_players SELECT _none_ PageSize 300 | 27,195 | 46 | 591.196 | 591.196 | 295.63 |
| COLLECTION /transactions/*/S8 | 22,506 | 56 | 401.893 | 401.893 | 401.893 |
| COLLECTION /live_games | 17,031 | 5,833 | 2.92 | 2.92 | 2.92 |

## Analysis Methodology

### Phase 1: Query Location and Context Discovery

**Objective:** Find all locations in the codebase where these queries are executed.

**Tasks:**
1. **Search for direct collection references:**
   - Search for `v2_players` collection references
   - Search for `transactions` collection with subcollections `S7` and `S8`
   - Search for `live_games` collection references
   - Look for both direct Firestore calls and abstracted database service calls

2. **Identify query patterns:**
   - Look for `.collection()` or `.get()` calls
   - Search for query builder patterns
   - Identify any ORM or database abstraction layer usage
   - Find where filters, ordering, and pagination are applied

3. **Document the context:**
   - Note which API endpoints or functions trigger these queries
   - Identify the frequency of execution (is it per-request, batch, scheduled?)
   - Understand the business logic requiring these queries
   - Map out the call stack leading to each query

### Phase 2: Database Architecture Understanding

**Objective:** Build a comprehensive understanding of the database structure and relationships.

**Tasks:**
1. **Schema analysis:**
   - Document the structure of each collection (`v2_players`, `transactions`, `live_games`)
   - Identify all fields in each collection
   - Note data types, nested objects, and arrays
   - Document any subcollection patterns (e.g., `transactions/*/S7`)

2. **Relationship mapping:**
   - Identify how collections relate to each other
   - Document foreign key equivalents or reference fields
   - Map out parent-child relationships (especially for subcollections)
   - Identify any denormalized data patterns

3. **Index review:**
   - Locate the database index configuration (typically `firestore.indexes.json` or similar)
   - Compare existing indexes against query patterns
   - Note which queries might be doing full collection scans
   - Identify composite indexes that may be needed

4. **Data access patterns:**
   - Understand read vs. write frequency for each collection
   - Identify hot paths and frequently accessed data
   - Note any caching layers or strategies currently in place
   - Document data consistency requirements

### Phase 3: Efficiency Analysis

**Objective:** Identify specific inefficiencies and their root causes.

**Critical Metrics to Analyze:**

1. **Scan-to-Return Ratio:**
   - **ALERT:** `/v2_players` queries scan 509 docs on average per execution but return all of them
   - **ALERT:** `/v2_players SELECT _none_` scans 591 docs but returns only 295 (2:1 ratio)
   - This suggests potential over-fetching or missing indexes

2. **Read Operations per Execution:**
   - `/v2_players`: 60,089 reads ÷ 118 executions = ~509 reads/execution (very high)
   - `/transactions/*/S7`: 34,440 reads ÷ 56 executions = ~615 reads/execution (very high)
   - Compare these to `/live_games`: 17,031 reads ÷ 5,833 executions = ~2.92 reads/execution (efficient)

3. **PageSize Analysis:**
   - The `/v2_players SELECT _none_ PageSize 300` query has pagination
   - Investigate if pagination is consistently applied across similar queries
   - Check if page size is appropriate for the use case

**Specific Issues to Investigate:**

1. **Missing Indexes:**
   - Are there filters or ordering clauses without corresponding indexes?
   - Look for queries that combine multiple filter conditions
   - Check for range queries that might need special indexes

2. **Over-fetching:**
   - Are queries returning more data than needed?
   - Is projection being used to limit returned fields (`SELECT _none_` suggests field limitation is already in use for one query)?
   - Could pagination be added to reduce data transfer?

3. **N+1 Query Problems:**
   - Are subcollection queries (`/transactions/*/S7`, `/transactions/*/S8`) being called in loops?
   - Could batch operations or collection group queries be used instead?
   - Look for patterns where a query is executed multiple times with different parameters

4. **Lack of Caching:**
   - Is relatively static data being queried repeatedly?
   - Could results be cached at the application or database layer?
   - Are there opportunities for materialized views or precomputed data?

### Phase 4: Optimization Recommendations

**Objective:** Provide specific, actionable recommendations ranked by impact.

**For each query, consider:**

#### 1. Index Optimization
- **Recommend specific composite indexes** based on query filters and ordering
- Provide the exact index definition (fields, direction, collection scope)
- Estimate the impact on read operations (aim for 1:1 scan-to-return ratio)

#### 2. Query Structure Improvements
- **Add pagination** where full collection scans are happening
- **Use projection** to return only necessary fields (already done for one query with `SELECT _none_`)
- **Implement field masking** to reduce data transfer
- **Add appropriate filters** to narrow result sets earlier

#### 3. Data Model Changes
- **Denormalization opportunities:** Could frequently joined data be duplicated?
- **Aggregation tables:** Should counts or summaries be pre-calculated?
- **Collection group queries:** Could replace multiple subcollection queries
- **Document restructuring:** Would flattening or nesting improve access patterns?

#### 4. Caching Strategy
- **Application-level caching:** For frequently accessed, infrequently changed data
- **Query result caching:** With appropriate TTLs based on data volatility
- **Edge caching:** For geographically distributed users
- **Partial caching:** Cache stable portions of dynamic data

#### 5. Code-Level Optimizations
- **Batch operations:** Combine multiple single-document reads
- **Parallel queries:** Execute independent queries concurrently
- **Lazy loading:** Defer expensive queries until actually needed
- **Query result reuse:** Avoid redundant queries within the same request

#### 6. Monitoring and Validation
- **Add query performance metrics** to track improvement
- **Implement query cost budgets** per endpoint
- **Set up alerts** for queries exceeding thresholds
- **A/B test** optimizations before full rollout

## Output Format

Please structure your analysis as follows:

### 1. Executive Summary
- Total queries analyzed
- Most critical inefficiencies identified
- Estimated potential savings (read operations, latency)

### 2. Per-Query Analysis

For each query:

```
#### Query: [Query Name]
**Current Performance:**
- Read Operations: [number]
- Executions: [number]
- Avg Reads/Execution: [calculated]
- Docs Scanned: [number]
- Results Returned: [number]
- Scan-to-Return Ratio: [calculated]

**Code Locations:**
- File: [path]
- Function: [name]
- Line: [number]
- Context: [description of what triggers this query]

**Identified Issues:**
1. [Issue description]
2. [Issue description]

**Recommended Optimizations:**
Priority: [High/Medium/Low]

1. [Optimization #1]
   - Implementation: [specific steps]
   - Expected Impact: [quantified when possible]
   - Effort: [High/Medium/Low]
   - Risk: [High/Medium/Low]

2. [Optimization #2]
   ...

**Index Recommendations:**
```json
{
  "collectionGroup": "[collection_name]",
  "queryScope": "COLLECTION",
  "fields": [
    {"fieldPath": "[field1]", "order": "ASCENDING"},
    {"fieldPath": "[field2]", "order": "DESCENDING"}
  ]
}
```

**Code Changes Required:**
```[language]
// Before
[current code snippet]

// After
[optimized code snippet]
```
```

### 3. Cross-Cutting Recommendations
- Database configuration changes
- Infrastructure improvements (caching, connection pooling)
- Development practices (query review process, monitoring)

### 4. Implementation Roadmap
Prioritized list of changes:
1. **Quick Wins** (High impact, low effort)
2. **Strategic Improvements** (High impact, high effort)
3. **Incremental Enhancements** (Medium impact, low effort)
4. **Long-term Considerations** (Medium/low impact, high effort)

### 5. Testing and Validation Plan
- How to test each optimization safely
- Metrics to track before and after
- Rollback procedures if issues arise

## Success Criteria

A successful analysis should:
1. ✅ Locate all query execution points in the codebase
2. ✅ Document the complete database schema and relationships
3. ✅ Identify at least 3 optimization opportunities per high-cost query
4. ✅ Provide quantified expected improvements (e.g., "reduce reads by 80%")
5. ✅ Include concrete, implementable code changes
6. ✅ Prioritize recommendations by impact vs. effort
7. ✅ Address both immediate performance wins and long-term architecture

## Key Considerations

- **Backward Compatibility:** Ensure optimizations don't break existing functionality
- **Data Consistency:** Maintain consistency requirements when adding caching
- **Cost vs. Benefit:** Consider development time vs. performance gains
- **Scalability:** Recommend solutions that work at increased scale
- **Monitoring:** Include plans to validate improvements in production
- **Documentation:** Update relevant documentation with changes

## Red Flags to Watch For

- Queries in loops (especially nested loops)
- Missing indexes on filtered/ordered fields
- Full collection scans on large collections
- Subcollection queries that could use collection groups
- Redundant queries within the same request
- Queries fetching data that's never used
- Lack of pagination on unbounded queries
- Missing field projection on large documents
- Synchronous queries that could be parallel
- No caching on frequently accessed, rarely changed data

## Next Steps

1. Clone and set up the codebase locally
2. Review database connection configuration
3. Begin Phase 1: Query Location Discovery
4. Document findings in the structured format above
5. Prioritize optimizations based on impact
6. Present findings and recommendations

---

**Remember:** The goal is not just to identify problems, but to provide clear, actionable solutions that the development team can implement to improve application performance and reduce database costs.
