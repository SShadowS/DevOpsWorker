codeunit 72282378 "CTS-CB Insert File Archive"
{
    procedure Insert(FileInStream: InStream; BankAccountNo: Code[20])
    var
        FileArchive: Record "CTS-CB File Archive";
    begin
        CreateRecord(FileInStream, FileArchive, BankAccountNo);
        FileArchive.Insert(true);
        Commit();
    end;

    local procedure CreateRecord(FileInStream: InStream; var FileArchive: Record "CTS-CB File Archive"; BankAccountNo: Code[20])
    begin
        FileArchive.Init();
        FileArchive."Bank Account No." := BankAccountNo;
    end;
}
