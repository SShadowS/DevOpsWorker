# AL Review Patterns

Known review patterns learned from real code reviews. These patterns represent common AL/Business Central pitfalls that experienced developers recognize but are easy to miss in automated review.

Each pattern has category tags for routing to the appropriate review domain.

---

## Rule 1: Redundant Caption with ShowCaption = false

**Categories:** page-design, property-interaction

**Rationale:** When `ShowCaption = false` is set on a group or field, the caption is hidden entirely. Setting `Caption = '';` alongside it is redundant noise — it adds a meaningless property that suggests the developer didn't understand what `ShowCaption = false` does.

**BAD:**
```al
group(General)
{
    Caption = '';
    ShowCaption = false;

    field(Name; Rec.Name)
    {
        // ...
    }
}
```

**GOOD:**
```al
group(General)
{
    ShowCaption = false;

    field(Name; Rec.Name)
    {
        // ...
    }
}
```

**Key insight:** `ShowCaption = false` is sufficient on its own. Omit `Caption` entirely when the caption is hidden.

---

## Rule 2: DrillDown Must Respect Page Editability

**Categories:** page-security, authorization

**Rationale:** A `trigger OnDrillDown()` can open a target page (e.g., a Card or Navigate page) that allows the user to modify data. If the source page is non-editable (read-only list, lookup, etc.), the DrillDown effectively bypasses the page's edit restriction — this is a privilege escalation vector where a user could reach an editable page and make unauthorized changes.

**BAD:**
```al
field("Document No."; Rec."Document No.")
{
    trigger OnDrillDown()
    begin
        // Opens an editable page unconditionally
        Page.Run(Page::"Sales Document Card", SalesDoc);
    end;
}
```

**GOOD:**
```al
field("Document No."; Rec."Document No.")
{
    trigger OnDrillDown()
    begin
        SalesDoc.SetRecFilter();
        if CurrPage.Editable then
            Page.Run(Page::"Sales Document Card", SalesDoc)
        else
            Page.Run(Page::"Sales Document Card", SalesDoc, true); // run as read-only
    end;
}
```

**Alternative:** Use `Page.RunModal` to prevent modifications, or check user permissions before allowing the DrillDown to proceed.

**Key insight:** Always check `CurrPage.Editable` or the user's permission level before opening editable pages from DrillDown triggers. Consider whether the target page should be opened in read-only mode.

---

## Rule 3: Clear Plaintext Credential After Migrating to IsolatedStorage

**Categories:** data-upgrade, security

**Rationale:** When a data upgrade codeunit migrates a sensitive value (e.g., an API key) from a plaintext table field to IsolatedStorage, the original plaintext field must be explicitly cleared in the same transaction. Failing to clear it leaves the secret stored in two places: the secure IsolatedStorage and the original unprotected table field. The plaintext copy persists indefinitely and could be read by any code or query that accesses the table.

**BAD:**
```al
if DOSetup."Azure Storage Account Key" <> '' then begin
    SharedKeySecret := DOSetup."Azure Storage Account Key";
    DOSetup.SetAzureStorageAccountSecret(SharedKeySecret);
    DOSetup."Azure Storage Auth. Type" := "CTS-SYS Azure Blob Auth. Type"::SharedKey;
    DOSetup.Modify();
    // BUG: plaintext key is still in the table — not cleared!
end;
```

**GOOD:**
```al
if DOSetup."Azure Storage Account Key" <> '' then begin
    SharedKeySecret := DOSetup."Azure Storage Account Key";
    DOSetup.SetAzureStorageAccountSecret(SharedKeySecret);
    DOSetup."Azure Storage Auth. Type" := "CTS-SYS Azure Blob Auth. Type"::SharedKey;
    DOSetup."Azure Storage Account Key" := '';  // Clear plaintext after migration
    DOSetup.Modify();
end;
```

**Key insight:** Any time a credential moves from a table field to IsolatedStorage, clear the source field in the same Modify() call.

---

## Rule 4: Mask All Credential Types Consistently in UI Placeholder Procedures

**Categories:** page-security, security

**Rationale:** When a settings page displays stored credentials using masked placeholder fields (showing `'***'` when a value is set, empty when not), every credential type supported by the page must be included in the placeholder update procedure. Omitting one credential type means its actual value — not a mask — will be visible in the UI control. This is easy to miss when a new auth type is added incrementally without updating the masking logic.

**BAD:**
```al
local procedure UpdatePlaceholders()
begin
    if DOSetup.GetAzureStorageAccountSecret().IsEmpty() then
        SharedKeyPlaceholder := ''
    else
        SharedKeyPlaceholder := '***';

    if DOSetup.GetAzureServPrincSecret().IsEmpty() then
        ServicePrincipalSecretPlaceholder := ''
    else
        ServicePrincipalSecretPlaceholder := '***';

    // BUG: SAS Token masking omitted — actual token value shown in UI
end;
```

**GOOD:**
```al
local procedure UpdatePlaceholders()
begin
    if DOSetup.GetAzureStorageAccountSecret().IsEmpty() then
        SharedKeyPlaceholder := ''
    else
        SharedKeyPlaceholder := '***';

    if DOSetup.GetAzureServPrincSecret().IsEmpty() then
        ServicePrincipalSecretPlaceholder := ''
    else
        ServicePrincipalSecretPlaceholder := '***';

    if DOSetup.GetAzureSASToken().IsEmpty() then
        SASTokenPlaceholder := ''
    else
        SASTokenPlaceholder := '***';
end;
```

**Key insight:** When adding a new credential type, audit all placeholder/masking procedures to ensure the new type is included. A systematic check of all `'***'` assignments should cover every stored secret.

---

## Rule 5: Standardize Field Name Abbreviations Before Publication

**Categories:** naming, breaking-changes

**Rationale:** AL table field names are permanent after the first extension release — renaming is a breaking change flagged by AppSourceCop rule AS0011. Inconsistent abbreviations across related fields (e.g., `'Serv. Pr.'` vs `'Serv. Princ.'` for the same concept) and punctuation typos (e.g., a stray period mid-name) are impossible to fix post-release without a major version break. These must be caught in pre-release review.

**BAD:**
```al
table 50000 "My Setup"
{
    fields
    {
        // Stray period mid-name (typo)
        field(203; "Azure Storage. Auth Type"; Enum "Auth Type") { }

        // Inconsistent abbreviation: 'Serv. Pr.' vs 'Serv. Princ.'
        field(204; "Azure Serv. Pr. Client Id"; Text[250]) { }
        field(205; "Azure Serv. Princ. Secret Key"; Text[250]) { }
        field(206; "Azure Serv. Pr. Tenant Id"; Text[250]) { }
    }
}
```

**GOOD:**
```al
table 50000 "My Setup"
{
    fields
    {
        field(203; "Azure Storage Auth. Type"; Enum "Auth Type") { }

        // Same abbreviation used across all related fields
        field(204; "Azure Serv. Pr. Client Id"; Text[250]) { }
        field(205; "Azure Serv. Pr. Secret Key"; Text[250]) { }
        field(206; "Azure Serv. Pr. Tenant Id"; Text[250]) { }
    }
}
```

**Key insight:** Before first release, review all new field names for consistent abbreviations and stray punctuation. After release, these become permanent.

---

## Rule 6: Use Label Variables for All User-Facing Strings

**Categories:** localization, error-handling

**Rationale:** All user-facing strings — error messages, dialog text, captions assigned at runtime — must be defined as `Label` variables, not hardcoded string literals. Labels are the only mechanism the AL translation system can extract for localization. Hardcoded strings are invisible to the `.xlf` translation pipeline and will always appear in the base language regardless of user locale.

**BAD:**
```al
if not IsImplementedInCloud then
    Error('Van distribution is not implemented in Cloud.');
```

**GOOD:**
```al
var
    VanDistributionNotImplInCloudErr: Label 'Van distribution is not implemented in Cloud.';

...

if not IsImplementedInCloud then
    Error(VanDistributionNotImplInCloudErr);
```

**Key insight:** Every string passed to `Error()`, `Message()`, `Confirm()`, or any UI-bound variable must come from a `Label` variable.

---

## Rule 7: Don't Wrap Error() with StrSubstNo — Error() Supports Placeholders Natively

**Categories:** error-handling

**Rationale:** `Error()`, `Message()`, and `Confirm()` in AL natively support format placeholders (`%1`, `%2`, etc.) as additional parameters — exactly like `StrSubstNo()`. Wrapping the label in `StrSubstNo()` before passing it to `Error()` is redundant and obscures intent.

**BAD:**
```al
var
    CouldNotConnectErr: Label 'Could not connect to %1: %2.';

Error(StrSubstNo(CouldNotConnectErr, StorageAccountName, ErrorMessage));
```

**GOOD:**
```al
var
    CouldNotConnectErr: Label 'Could not connect to %1: %2.';

Error(CouldNotConnectErr, StorageAccountName, ErrorMessage);
```

**Key insight:** `Error()` and `Message()` handle placeholder substitution natively. Never wrap with `StrSubstNo()`.
