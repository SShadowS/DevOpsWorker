# Labels and Error Messages

## Rule A — Always use labels for user-facing strings

All `Error()`, `Message()`, `FieldError()`, and `Confirm()` text must come from `label` variables — never hardcoded string literals. Labels enable translation and consistent message management.

**Bad:**
```al
Error('Document %1 not found.', DocNo);
```

**Good:**
```al
var
    DocumentNotFoundErr: Label 'Document %1 not found.';

Error(DocumentNotFoundErr, DocNo);
```

## Rule B — Never use StrSubstNo in error messages

`Error()` already performs placeholder substitution (`%1`, `%2`, etc.) — wrapping in `StrSubstNo()` is redundant and obscures intent.

**Bad:**
```al
Error(StrSubstNo(SomeLabel, Value1, Value2));
```

**Good:**
```al
Error(SomeLabel, Value1, Value2);
```

The same applies to `Message()` — it also supports direct placeholder substitution. Never write `Message(StrSubstNo(...))`.
