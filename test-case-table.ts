const Table = require('cli-table');

let t = new Table();

t.push(['First value', 'Second value'])

console.log(t.toString());
