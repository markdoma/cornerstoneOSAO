FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /source
COPY IntegrationLab.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish --no-restore -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out ./
ENV ASPNETCORE_URLS=http://0.0.0.0:3003
USER $APP_UID
ENTRYPOINT ["dotnet", "IntegrationLab.dll"]
