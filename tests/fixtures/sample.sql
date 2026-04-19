CREATE PROCEDURE [dbo].[GetActiveUsers]
    @TenantId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Email
    FROM Users
    WHERE TenantId = @TenantId AND IsActive = 1;
END
