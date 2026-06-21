codeunit 72282377 "CTS-CB Azure Blob Imp.CSV File"
{
    procedure ImportStream(ImportInStream: InStream; BankAccountNo: Code[20])
    var
        CTSCBInsertFileArchive: Codeunit "CTS-CB Insert File Archive";
    begin
        CTSCBInsertFileArchive.Insert(ImportInStream, BankAccountNo);
    end;

    local procedure CreateRecord()
    begin
    end;
}
