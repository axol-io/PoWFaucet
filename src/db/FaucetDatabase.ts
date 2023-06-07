import * as SQLite3 from 'better-sqlite3';

import { faucetConfig } from '../config/FaucetConfig';
import { FaucetProcess, FaucetLogLevel } from '../common/FaucetProcess';
import { ServiceManager } from '../common/ServiceManager';
import { FaucetSessionStatus, FaucetSessionStoreData } from '../session/FaucetSession';
import { BaseModule } from '../modules/BaseModule';
import { ClaimTxStatus, EthClaimData } from '../eth/EthClaimManager';
import { FaucetModuleDB } from './FaucetModuleDB';

export class FaucetDatabase {
  private initialized: boolean;
  private db: SQLite3.Database;
  private moduleDBs: {[module: string]: FaucetModuleDB} = {};

  public initialize() {
    if(this.initialized)
      return;
    this.initialized = true;

    this.initDatabase();
    setInterval(() => {
      this.cleanStore();
    }, (1000 * 60 * 60 * 2));
  }

  private initDatabase() {
    this.db = new SQLite3.default(faucetConfig.faucetDBFile, {
      //verbose: console.log
    });
    this.db.pragma('journal_mode = WAL');
    this.upgradeSchema();
  }

  public closeDatabase() {
    this.db.close();
  }

  public createModuleDb<TModDB extends FaucetModuleDB>(dbClass: new(module: BaseModule, faucetStore: FaucetDatabase) => TModDB, module: BaseModule): TModDB {
    let modName = module.getModuleName();
    let modDb: TModDB;
    if(!(modDb = this.moduleDBs[modName] as TModDB)) {
      modDb = this.moduleDBs[modName] = new dbClass(module, this);
      modDb.initSchema();
    }
    return modDb;
  }

  public disposeModuleDb(moduleDb: FaucetModuleDB) {
    if(this.moduleDBs[moduleDb.getModuleName()] === moduleDb)
      delete this.moduleDBs[moduleDb.getModuleName()];
  }

  public getDatabase(): SQLite3.Database {
    return this.db;
  }

  public upgradeIfNeeded(module: string, latestVersion: number, upgrade: (version: number) => number) {
    let schemaVersion: number = 0;
    
    let res = this.db.prepare("SELECT Version FROM SchemaVersion WHERE Module = ?").get(module) as {Version: number};
    if(res)
      schemaVersion = res.Version;
    else
      this.db.prepare("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)").run(module, 0);

    let upgradedVersion = schemaVersion;
    if(schemaVersion != latestVersion) {
      upgradedVersion = upgrade(schemaVersion);
    }
    if(upgradedVersion != schemaVersion) {
      this.db.prepare("UPDATE SchemaVersion SET Version = ? WHERE Module = ?").run(upgradedVersion, module);
    }
  }

  private upgradeSchema() {
    let schemaVersion: number = 0;
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS "SchemaVersion" (
        "Module" TEXT NULL UNIQUE,
        "Version" INTEGER NOT NULL,
        PRIMARY KEY("Module")
      )
    `).run();
    let res = this.db.prepare("SELECT Version FROM SchemaVersion WHERE Module IS NULL").get() as {Version: number};
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Current FaucetStore schema version: " + (res ? res.Version : "uninitialized"));
    if(res)
      schemaVersion = res.Version;
    else
      this.db.prepare("INSERT INTO SchemaVersion (Module, Version) VALUES (NULL, ?)").run(0);
    
    let oldVersion = schemaVersion;
    switch(schemaVersion) {
      case 0: // upgrade to version 1
        schemaVersion = 1;
        this.db.exec(`
          CREATE TABLE "KeyValueStore" (
            "Key"	TEXT NOT NULL UNIQUE,
            "Value"	TEXT NOT NULL,
            PRIMARY KEY("Key")
          );
          CREATE TABLE "Sessions" (
            "SessionId" TEXT NOT NULL UNIQUE,
            "Status" TEXT NOT NULL,
            "StartTime" INTEGER NOT NULL,
            "TargetAddr" TEXT NOT NULL,
            "DropAmount" TEXT NOT NULL,
            "RemoteIP" TEXT NOT NULL,
            "Tasks" TEXT NOT NULL,
            "Data" TEXT NOT NULL,
            "ClaimData" TEXT NULL,
            PRIMARY KEY("SessionId")
          );
          CREATE INDEX "SessionsTimeIdx" ON "Sessions" (
            "StartTime"	ASC
          );
          CREATE INDEX "SessionsStatusIdx" ON "Sessions" (
            "Status"	ASC
          );
        `);
      /*
      case 1: // upgrade to version 2
        schemaVersion = 2;
        this.db.exec(`
          
        `);
      */
    }
    if(schemaVersion !== oldVersion) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Upgraded FaucetStore schema from version " + oldVersion + " to version " + schemaVersion);
      this.db.prepare("UPDATE SchemaVersion SET Version = ? WHERE Module IS NULL").run(schemaVersion);
    }
  }


  private now(): number {
    return Math.floor((new Date()).getTime() / 1000);
  }

  public cleanStore() {
    let now = this.now();
    //this.db.prepare("DELETE FROM PassportCache WHERE Timeout < ?").run(now);
    //TODO: clean Sessions

    Object.values(this.moduleDBs).forEach((modDb) => {
      modDb.cleanStore();
    });
  }

  public getKeyValueEntry(key: string): string {
    let row = this.db.prepare("SELECT Value FROM KeyValueStore WHERE Key = ?")
      .get(key) as {Value: string};
    return row?.Value;
  }

  public setKeyValueEntry(key: string, value: string) {
    let row = this.db.prepare("SELECT Key FROM KeyValueStore WHERE Key = ?").get(key);
    if(row) {
      this.db.prepare("UPDATE KeyValueStore SET Value = ? WHERE Key = ?")
        .run(value, key);
    }
    else {
      this.db.prepare("INSERT INTO KeyValueStore (Key, Value) VALUES (?, ?)")
        .run(key, value);
    }
  }

  public deleteKeyValueEntry(key: string) {
    this.db.prepare("DELETE FROM KeyValueStore WHERE Key = ?").run(key);
  }

  public getSessions(states: FaucetSessionStatus[]): FaucetSessionStoreData[] {
    let query = this.db.prepare("SELECT SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData FROM Sessions WHERE Status IN (" + states.map(() => "?").join(",") + ")");
    let rows = query.all.apply(query, states) as {
      SessionId: string;
      Status: string;
      StartTime: number;
      TargetAddr: string;
      DropAmount: string;
      RemoteIP: string;
      Tasks: string;
      Data: string;
      ClaimData: string;
    }[];

    if(rows.length === 0)
      return [];
    
    return rows.map((row) => {
      return {
        sessionId: row.SessionId,
        status: row.Status as FaucetSessionStatus,
        startTime: row.StartTime,
        targetAddr: row.TargetAddr,
        dropAmount: row.DropAmount,
        remoteIP: row.RemoteIP,
        tasks: JSON.parse(row.Tasks),
        data: JSON.parse(row.Data),
        claim: row.ClaimData ? JSON.parse(row.ClaimData) : null,
      };
    });
  }

  public getAllSessions(timeLimit: number): FaucetSessionStoreData[] {
    let now = Math.floor(new Date().getTime() / 1000);

    let query = this.db.prepare("SELECT SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData FROM Sessions WHERE Status NOT IN ('finished', 'failed') OR StartTime > ?");
    let rows = query.all(now - timeLimit) as {
      SessionId: string;
      Status: string;
      StartTime: number;
      TargetAddr: string;
      DropAmount: string;
      RemoteIP: string;
      Tasks: string;
      Data: string;
      ClaimData: string;
    }[];

    if(rows.length === 0)
      return [];
    
    return rows.map((row) => {
      return {
        sessionId: row.SessionId,
        status: row.Status as FaucetSessionStatus,
        startTime: row.StartTime,
        targetAddr: row.TargetAddr,
        dropAmount: row.DropAmount,
        remoteIP: row.RemoteIP,
        tasks: JSON.parse(row.Tasks),
        data: JSON.parse(row.Data),
        claim: row.ClaimData ? JSON.parse(row.ClaimData) : null,
      };
    });
  }

  public getSession(sessionId: string): FaucetSessionStoreData {
    let query = this.db.prepare("SELECT SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData FROM Sessions WHERE SessionId = ?");
    let row = query.get(sessionId) as {
      SessionId: string;
      Status: string;
      StartTime: number;
      TargetAddr: string;
      DropAmount: string;
      RemoteIP: string;
      Tasks: string;
      Data: string;
      ClaimData: string;
    };

    if(!row)
      return null;
    
    return {
      sessionId: row.SessionId,
      status: row.Status as FaucetSessionStatus,
      startTime: row.StartTime,
      targetAddr: row.TargetAddr,
      dropAmount: row.DropAmount,
      remoteIP: row.RemoteIP,
      tasks: JSON.parse(row.Tasks),
      data: JSON.parse(row.Data),
      claim: row.ClaimData ? JSON.parse(row.ClaimData) : null,
    };
  }

  public updateSession(sessionData: FaucetSessionStoreData) {
    this.db.prepare("INSERT OR REPLACE INTO Sessions (SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData) VALUES (?,?,?,?,?,?,?,?,?)").run(
      sessionData.sessionId,
      sessionData.status,
      sessionData.startTime,
      sessionData.targetAddr,
      sessionData.dropAmount,
      sessionData.remoteIP,
      JSON.stringify(sessionData.tasks),
      JSON.stringify(sessionData.data),
      sessionData.claim ? JSON.stringify(sessionData.claim) : null
    );
  }

  public updateClaimData(sessionId: string, claimData: EthClaimData) {
    let status: FaucetSessionStatus;
    switch(claimData.claimStatus) {
      case ClaimTxStatus.CONFIRMED:
        status = FaucetSessionStatus.FINISHED;
        break;
      case ClaimTxStatus.FAILED:
        status = FaucetSessionStatus.FAILED;
        break;
      default:
        status = FaucetSessionStatus.CLAIMING;
        break;
    }
    this.db.prepare("UPDATE Sessions SET Status = ?, ClaimData = ? WHERE Status = 'claiming' AND SessionId = ?").run(
      status,
      JSON.stringify(claimData),
      sessionId
    );
  }

  public getClaimableAmount(): bigint {
    let query = this.db.prepare("SELECT SUM(DropAmount) AS TotalAmount FROM Sessions WHERE Status = 'claimable'");
    let row = query.get() as {
      TotalAmount: string;
    };
    if(!row || !row.TotalAmount)
      return 0n;
    return BigInt(row.TotalAmount)
  }

}
