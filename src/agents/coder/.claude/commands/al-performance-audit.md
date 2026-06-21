# AL Performance Audit

Perform a comprehensive performance analysis of an AL (Business Central) codebase.

## Input
$ARGUMENTS - Path to the AL project folder to analyze (e.g., `U:\Git\MyProject\App`)

## Process

### Phase 1: Discovery & Setup

1. **Create output directory**: `$ARGUMENTS/.performance-analysis/`

2. **Explore codebase structure** using Explore agents in parallel:
   - Agent 1: Map folder structure, count AL files, identify object types distribution
   - Agent 2: Search for performance anti-patterns (SetLoadFields usage, loops with database ops, CalcFields patterns)
   - Agent 3: Identify complex business logic areas (large codeunits, posting routines, batch processing)

3. **Categorize files by priority** based on:
   - CRITICAL: Files with nested loops, N+1 patterns, Count() in loops
   - HIGH: Files with missing SetLoadFields, record-by-record operations
   - MEDIUM: Files with potential caching opportunities
   - LOW: Small utility files

### Phase 2: Structured Analysis

Group files into logical batches and analyze using `al-performance-analyzer` agent in parallel:

**Batch structure** (adapt based on codebase):
- Group 1: Authentication/Security modules
- Group 2: Core business logic (posting, validation)
- Group 3: Integration/Communication modules
- Group 4: File processing/Import-Export
- Group 5: Helper/Utility modules

**For each batch**, launch `al-performance-analyzer` with:
```
Analyze [module name] for performance anti-patterns.

Files to analyze:
1. [file path 1]
2. [file path 2]
3. [file path 3]

Focus areas:
- Database query inefficiencies (N+1 patterns)
- SetLoadFields usage gaps
- Loop performance issues
- Temporary table handling
- Caching opportunities

Output: Create .Performance.md file for EACH codeunit in same location as source.
```

### Phase 3: Consolidate Reports

1. **Move all reports** to `.performance-analysis/` folder with clean names:
   - `ObjectName.Codeunit.Performance.md` → `ObjectName.Codeunit.md`

2. **Generate index.md** with:
   - Executive summary (total files, issue counts by severity)
   - Status distribution (Needs Optimization / Acceptable / Optimized)
   - Top critical issues table
   - Top high-priority fixes table
   - Reports by module (linked tables)
   - Common anti-patterns found
   - Recommended fix priority (Tier 1/2/3)
   - Bugs discovered (if any)
   - Positive patterns observed

## Output Structure

```
$ARGUMENTS/.performance-analysis/
├── index.md                    # Navigation hub
├── ObjectName1.Codeunit.md     # Per-object report
├── ObjectName2.Codeunit.md
├── ObjectName3.Codeunit.md
└── ... (one per analyzed object)
```

## Per-Object Report Format

Each report must contain:
1. **Header**: File path, line count, overall status
2. **Issue Summary Table**: Severity counts
3. **Detailed Issues**: Each with severity, line numbers, description
4. **Code Examples**: Before/after for each fix
5. **Recommendations**: Prioritized action items

## Anti-Patterns to Detect

| Category | Pattern | Severity |
|----------|---------|----------|
| N+1 Query | Get()/FindFirst() inside loop | CRITICAL/HIGH |
| Missing SetLoadFields | Query without field restriction | HIGH/MEDIUM |
| Count() in loops | Repeated Count() calls | HIGH |
| List.Contains() in loops | O(n²) lookups | CRITICAL |
| Record-by-record inserts | Insert() in loop | HIGH |
| Double-reads | FindSet then Get same record | CRITICAL |
| Integration events in loops | OnX events in repeat | CRITICAL |
| Commit() in loops | Transaction overhead | CRITICAL |
| Inefficient distinct | Deep copy for unique values | HIGH |

## Status Classification

- **Needs Optimization**: Has CRITICAL issues OR 3+ HIGH issues
- **Acceptable**: Has 1-2 HIGH issues OR only MEDIUM/LOW issues
- **Optimized**: No issues OR only LOW issues with good patterns

### Phase 4: Generate PDF Report

After all analysis is complete, generate a consolidated PDF report:

1. **Create combined markdown** by concatenating index.md and all object reports:
   ```bash
   cd "$ARGUMENTS/.performance-analysis"
   cat index.md > full-report.md
   echo -e "\n\n---\n\n# Individual Object Reports\n" >> full-report.md
   for f in *.Codeunit.md; do
     echo -e "\n---\n" >> full-report.md
     cat "$f" >> full-report.md
   done
   ```

2. **Generate PDF with pandoc and xelatex**:
   ```bash
   pandoc full-report.md \
     -o "Performance-Analysis-Report.pdf" \
     --pdf-engine=xelatex \
     --toc \
     --toc-depth=3 \
     -V geometry:margin=1in \
     -V documentclass=report \
     -V fontsize=11pt \
     -V colorlinks=true \
     -V linkcolor=blue \
     -V toccolor=black \
     --syntax-highlighting \
     -M title="AL Performance Analysis Report" \
     -M date="$(date +%Y-%m-%d)"
   ```

3. **Clean up** temporary combined markdown (optional):
   ```bash
   rm full-report.md
   ```

## Output Structure

```
$ARGUMENTS/.performance-analysis/
├── index.md                           # Navigation hub
├── Performance-Analysis-Report.pdf    # Complete PDF report
├── ObjectName1.Codeunit.md            # Per-object report
├── ObjectName2.Codeunit.md
├── ObjectName3.Codeunit.md
└── ... (one per analyzed object)
```

## Execution Notes

- Launch up to 3 al-performance-analyzer agents in parallel per batch
- Move reports to central folder after each batch completes
- Track progress with TodoWrite tool
- Generate index.md only after all analysis complete
- Generate PDF as final step after index.md is created
