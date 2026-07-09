const fs = require('fs').promises;
const path = require('path');

class Collection {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = [];
    }

    async load() {
        try {
            const content = await fs.readFile(this.filePath, 'utf8');
            this.data = JSON.parse(content);
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.data = [];
                await this.save();
            } else {
                console.error(`Error loading database file ${this.filePath}:`, error);
                this.data = [];
            }
        }
    }

    async save() {
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (error) {
            console.error(`Error saving database file ${this.filePath}:`, error);
        }
    }

    _matches(doc, query) {
        for (const key in query) {
            if (query[key] !== doc[key]) {
                return false;
            }
        }
        return true;
    }

    async find(query = {}) {
        await this.load();
        return this.data.filter(doc => this._matches(doc, query));
    }

    async findOne(query = {}) {
        await this.load();
        return this.data.find(doc => this._matches(doc, query)) || null;
    }

    async insert(doc) {
        await this.load();
        const newDoc = {
            _id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
            ...doc,
            createdAt: new Date().toISOString()
        };
        this.data.push(newDoc);
        await this.save();
        return newDoc;
    }

    async update(query, updateQuery, options = {}) {
        await this.load();
        let updatedCount = 0;
        const docsToUpdate = this.data.filter(doc => this._matches(doc, query));

        for (const doc of docsToUpdate) {
            const index = this.data.indexOf(doc);
            if (index !== -1) {
                // Support both standard replacement or $set update
                if (updateQuery.$set) {
                    this.data[index] = { ...this.data[index], ...updateQuery.$set };
                } else {
                    this.data[index] = { ...this.data[index], ...updateQuery };
                }
                updatedCount++;
                if (options.multi === false) {
                    break;
                }
            }
        }

        if (updatedCount > 0) {
            await this.save();
        }
        return updatedCount;
    }

    async delete(query, options = {}) {
        await this.load();
        const initialLength = this.data.length;
        if (options.multi === false) {
            const index = this.data.findIndex(doc => this._matches(doc, query));
            if (index !== -1) {
                this.data.splice(index, 1);
            }
        } else {
            this.data = this.data.filter(doc => !this._matches(doc, query));
        }
        const deletedCount = initialLength - this.data.length;
        if (deletedCount > 0) {
            await this.save();
        }
        return deletedCount;
    }
}

class DB {
    constructor(dbDir) {
        this.dbDir = dbDir;
        this.collections = {};
    }

    collection(name) {
        if (!this.collections[name]) {
            const filePath = path.join(this.dbDir, `${name}.json`);
            this.collections[name] = new Collection(filePath);
        }
        return this.collections[name];
    }
}

module.exports = (dbDir) => new DB(dbDir);
