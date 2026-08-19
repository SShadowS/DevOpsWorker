codeunit 72282999 "CTS-CB Vendored Helper"
{
    // Lives under a DOT-DIRECTORY on purpose. `.dependencies/` is where the
    // companion apps' source is vendored in every one of these repos, so a
    // resolver that cannot see it is blind to exactly the callees a reviewer
    // cannot read from the diff.
    procedure VendoredOnlyProc(Value: Integer): Integer
    begin
        exit(Value * 2);
    end;
}
